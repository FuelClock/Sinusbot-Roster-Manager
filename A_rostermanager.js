// Roster Manager Plugin v0.1.0 for SinusBot
// Guild roster system for Goud Graaiers: onboarding intro tracking, rank /
// server group management, leadership notes and the Taverne messageboard.
// Follows the same pattern as A_bountyboard.js / A_eventmanager.js with
// OKlib integration and a tested fallback path.

registerPlugin({
    name: 'Roster Manager',
    version: '0.1.0',
    author: 'FuelClock',
    description: 'Guild roster with intro tracking, ranks, leadership notes and taverne messageboard',
    backends: ['ts3'],
    vars: [
        { name: 'BOT_NAME', title: 'Bot Command Name', type: 'string', default: 'roster' },
        { name: 'TAVERNE_NAME', title: 'Taverne Command Name', type: 'string', default: 'taverne' },
        { name: 'LEADERSHIP_GROUP', title: 'Server Group ID (leadership)', type: 'string', default: '17' },
        { name: 'MEMBERSHIP_GROUPS', title: 'Membership server group IDs (comma-separated, assigned by assign)', type: 'string', default: '23' },
        { name: 'MESSAGEBOARD_ENABLED', title: 'Enable taverne messageboard', type: 'select', options: ['enabled', 'disabled'], default: 'enabled' },
        { name: 'MESSAGEBOARD_CHANNEL_ID', title: 'Channel for taverne messages (description)', type: 'channel' },
        { name: 'MAX_SHOWN_MESSAGES', title: 'Max taverne messages shown (newest at top)', type: 'number', default: 50 },
        { name: 'MESSAGEBOARD_TITLE', title: 'Taverne title in the channel description', type: 'string', default: 'Guild Messages' }
    ],
    requiredModules: ['engine', 'backend', 'event', 'store'],
    autorun: false
}, function(_, config, meta) {
    const engine = require('engine');
    const backend = require('backend');
    const event = require('event');

    var botName = String(config.BOT_NAME || 'roster');
    var taverneName = String(config.TAVERNE_NAME || 'taverne');
    var leadershipGroupId = String(config.LEADERSHIP_GROUP || '17');
    var membershipGroupIds = String(config.MEMBERSHIP_GROUPS || '23').split(',').map(function(s) { return String(s).trim(); }).filter(Boolean);
    var messageboardEnabled = !(config.MESSAGEBOARD_ENABLED === 'disabled' || config.MESSAGEBOARD_ENABLED === 1);
    var messageboardChannelId = configuredId(config.MESSAGEBOARD_CHANNEL_ID);
    var maxShownMessages = Math.max(1, parseInt(config.MAX_SHOWN_MESSAGES, 10) || 50);
    var messageboardTitle = String(config.MESSAGEBOARD_TITLE || 'Guild Messages');

    function configuredId(value) {
        if (!value) return '';
        if (typeof value === 'object' && typeof value.id === 'function') return String(value.id());
        if (typeof value === 'object' && value.id !== undefined) return String(value.id);
        return String(value);
    }

    // Ranks are fixed (seeded on first start, listed with !roster ranks) —
    // no add/remove commands, none are expected to be needed.
    var DEFAULT_RANKS = { Matroos: 25, Korporaal: 26, Sergeant: 30, Majoor: 31, Admiraal: 27, Founder: 28 };
    // Rank granted automatically when an online player is added to the roster.
    var DEFAULT_RANK = 'Matroos';

    function loadRanks() {
        var raw = store ? store.get('rosterRanks') : null;
        if (raw) {
            try {
                var parsed = JSON.parse(raw);
                if (parsed && typeof parsed === 'object') {
                    ranks = parsed;
                    return;
                }
            } catch (e) {
                logMessage('ERROR parsing stored ranks: ' + e.message, 1);
            }
        }
        ranks = {};
        for (var seed in DEFAULT_RANKS) {
            if (DEFAULT_RANKS.hasOwnProperty(seed)) {
                ranks[seed] = DEFAULT_RANKS[seed];
            }
        }
        saveRanks();
        logMessage('Seeded default ranks (first start): ' + Object.keys(ranks).join(', '), 3);
    }

    function saveRanks() {
        if (!store) {
            return;
        }
        try {
            store.set('rosterRanks', JSON.stringify(ranks));
        } catch (e) {
            logMessage('ERROR saving ranks: ' + e.message, 1);
        }
    }
    var ranks = {};

    // ===== PERSISTENCE =====
    var players = [];        // roster records
    var messages = [];       // taverne messages (oldest -> newest)
    var noteIdCounter = 0;   // global sequential note IDs
    var persistenceInitialized = false;
    var store = null;

    // ===== STORE MODULE =====
    try {
        store = require('store');
        logMessage('Store module loaded for persistence', 3);
    } catch (e) {
        logMessage('FATAL: Store module unavailable — persistence disabled. Add "store" to requiredModules in manifest.', 1);
        store = null;
    }

    // ===== OKLIB INTEGRATION =====
    var oklib = null;
    var oklibAvailable = false;

    try {
        var loadedOklib = require('OKlib.js');
        if (loadedOklib && loadedOklib.general &&
            typeof loadedOklib.general.checkVersion === 'function' &&
            loadedOklib.general.checkVersion('1.0.6')) {
            oklib = loadedOklib;
            oklibAvailable = true;
        }
    } catch (e) {
        logMessage('WARNING: OKlib could not be loaded: ' + e.message, 2);
    }

    if (!oklibAvailable) {
        logMessage('WARNING: OKlib 1.0.6+ unavailable — using manual implementations', 2);
    } else {
        logMessage('OKlib loaded successfully (v1.0.6+)', 3);
    }

    function logMessage(message, level) {
        if (oklibAvailable && oklib.general && typeof oklib.general.log === 'function') {
            oklib.general.log(message, level || 4);
            return;
        }
        engine.log(message);
    }

    function containsIgnoreCase(value, search) {
        if (oklibAvailable && oklib.comparator && typeof oklib.comparator.containsIgnoreCase === 'function') {
            return oklib.comparator.containsIgnoreCase(String(value || ''), String(search || ''));
        }
        return String(value || '').toLowerCase().indexOf(String(search || '').toLowerCase()) !== -1;
    }

    function equalsIgnoreCase(left, right) {
        return containsIgnoreCase(left, right) && containsIgnoreCase(right, left);
    }

    function startsWithIgnoreCase(value, prefix) {
        value = String(value || '');
        prefix = String(prefix || '');
        return equalsIgnoreCase(value.substring(0, prefix.length), prefix);
    }

    function isMemberOfOne(client, groups) {
        if (oklibAvailable && oklib.client && typeof oklib.client.isMemberOfOne === 'function') {
            return oklib.client.isMemberOfOne(client, groups);
        }

        if (!client || typeof client.getServerGroups !== 'function') {
            return false;
        }

        var groupIds = Array.isArray(groups) ? groups : [groups];
        var clientGroups = client.getServerGroups();
        for (var i = 0; i < clientGroups.length; i++) {
            var clientId = String(clientGroups[i].id());
            for (var j = 0; j < groupIds.length; j++) {
                if (clientId === String(groupIds[j])) {
                    return true;
                }
            }
        }
        return false;
    }

    function searchClients(query, partMatch, caseSensitive, clients) {
        if (oklibAvailable && oklib.client && typeof oklib.client.search === 'function') {
            return oklib.client.search(query, partMatch, caseSensitive, clients);
        }

        var searchPool = Array.isArray(clients) ? clients : backend.getClients();
        var searchTerm = String(query || '');
        var results = [];
        for (var i = 0; i < searchPool.length; i++) {
            var client = searchPool[i];
            var clientName = typeof client.name === 'function' ? client.name() : String(client.name || '');
            var nameMatches = caseSensitive
                ? clientName === searchTerm
                : equalsIgnoreCase(clientName, searchTerm);
            if (partMatch) {
                nameMatches = caseSensitive
                    ? clientName.indexOf(searchTerm) !== -1
                    : containsIgnoreCase(clientName, searchTerm);
            }

            if (nameMatches || String(client.uid ? client.uid() : '').indexOf(searchTerm) !== -1 ||
                String(client.id ? client.id() : '').indexOf(searchTerm) !== -1) {
                results.push(client);
            }
        }
        return results;
    }

    function isLeadership(invoker) {
        return isMemberOfOne(invoker, [leadershipGroupId]);
    }

    function addToServerGroups(client, groups) {
        if (!client || typeof client.addToServerGroup !== 'function') {
            return false;
        }
        var list = Array.isArray(groups) ? groups : [groups];
        for (var i = 0; i < list.length; i++) {
            try {
                if (!isMemberOfOne(client, [list[i]])) {
                    client.addToServerGroup(list[i]);
                    logMessage('Added ' + client.name() + ' to server group ' + list[i], 4);
                }
            } catch (e) {
                logMessage('Failed to add ' + client.name() + ' to server group ' + list[i] + ': ' + e.message, 2);
            }
        }
        return true;
    }

    function removeFromServerGroups(client, groups) {
        if (!client || typeof client.removeFromServerGroup !== 'function') {
            return false;
        }
        var list = Array.isArray(groups) ? groups : [groups];
        for (var i = 0; i < list.length; i++) {
            try {
                if (isMemberOfOne(client, [list[i]])) {
                    client.removeFromServerGroup(list[i]);
                    logMessage('Removed ' + client.name() + ' from server group ' + list[i], 4);
                }
            } catch (e) {
                logMessage('Failed to remove ' + client.name() + ' from server group ' + list[i] + ': ' + e.message, 2);
            }
        }
        return true;
    }

    if (!oklibAvailable) {
        oklib = {
            general: {
                checkVersion: function() { return false; },
                log: logMessage
            },
            client: {
                search: searchClients,
                isMemberOfOne: isMemberOfOne
            },
            comparator: {
                containsIgnoreCase: containsIgnoreCase
            }
        };
    }

    // ===== SCRIPT INITIALIZATION =====
    event.on('load', function(ev) {
        logMessage('Roster Manager v0.1.0 loaded');
        logMessage('Configuration - BotName: ' + botName + ', LeadershipGroup: ' + leadershipGroupId +
            ', MembershipGroups: [' + membershipGroupIds.join(',') + '], Taverne: ' +
            (messageboardEnabled ? 'enabled' : 'disabled') + ' channel=' + messageboardChannelId);

        if (backend.isConnected()) {
            initialize();
        } else {
            event.on('connect', function() {
                initialize();
            });
        }
    });

    function initialize() {
        logMessage('Initializing roster manager system...');
        loadRanks();
        loadPersistedData();
        persistenceInitialized = true;
        if (messageboardEnabled) {
            updateTaverneDescription();
        }
        logMessage('Initialization complete. Loaded ' + players.length + ' players, ' +
            Object.keys(ranks).length + ' ranks, ' + messages.length + ' taverne messages');
    }

    // ===== PERSISTENCE HELPERS =====
    function sanitizePlayer(entry) {
        if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string' || !entry.name) {
            return null;
        }
        var out = {};
        for (var key in entry) {
            if (entry.hasOwnProperty(key)) {
                out[key] = entry[key];
            }
        }
        out.name = entry.name;
        out.introStatus = (entry.introStatus === 'introduced') ? 'introduced' : 'pending';
        out.rank = (typeof entry.rank === 'string') ? entry.rank : '';
        out.notes = Array.isArray(entry.notes) ? entry.notes : [];
        out.createdAt = (typeof entry.createdAt === 'string' && entry.createdAt) ? entry.createdAt : new Date().toISOString();
        return out;
    }

    function saveData() {
        if (!store) {
            return;
        }
        try {
            store.set('rosterPlayers', JSON.stringify(players));
            store.set('taverneMessages', JSON.stringify(messages));
            store.set('rosterNoteCounter', String(noteIdCounter));
        } catch (e) {
            logMessage('ERROR saving data: ' + e.message, 1);
        }
    }

    function loadPersistedData() {
        if (!store) {
            logMessage('WARNING: Cannot load data — store module unavailable, starting empty', 2);
            return;
        }
        try {
            var rawPlayers = store.get('rosterPlayers');
            if (rawPlayers) {
                var parsedPlayers = JSON.parse(rawPlayers);
                var loadedPlayers = [];
                if (Array.isArray(parsedPlayers)) {
                    for (var i = 0; i < parsedPlayers.length; i++) {
                        var clean = sanitizePlayer(parsedPlayers[i]);
                        if (clean) {
                            loadedPlayers.push(clean);
                        }
                    }
                }
                players = loadedPlayers;
            }
            var rawMessages = store.get('taverneMessages');
            if (rawMessages) {
                var parsedMessages = JSON.parse(rawMessages);
                messages = Array.isArray(parsedMessages) ? parsedMessages : [];
            }
            var rawCounter = store.get('rosterNoteCounter');
            if (rawCounter) {
                var counter = parseInt(rawCounter, 10);
                if (!isNaN(counter) && counter > noteIdCounter) {
                    noteIdCounter = counter;
                }
            }
            // Keep the note counter above any loaded note ID (migration safety).
            for (var p = 0; p < players.length; p++) {
                var notes = players[p].notes;
                if (Array.isArray(notes)) {
                    for (var n = 0; n < notes.length; n++) {
                        var noteId = parseInt(notes[n] && notes[n].id, 10);
                        if (!isNaN(noteId) && noteId > noteIdCounter) {
                            noteIdCounter = noteId;
                        }
                    }
                }
            }
        } catch (e) {
            logMessage('ERROR loading persisted data: ' + e.message, 1);
            players = [];
            messages = [];
        }
    }

    // ===== ROSTER RECORD HELPERS =====
    function findPlayer(name) {
        var target = String(name || '').trim();
        if (!target) {
            return null;
        }
        // Exact match first, then prefix match (bounty board convention).
        for (var i = 0; i < players.length; i++) {
            if (equalsIgnoreCase(players[i].name, target)) {
                return players[i];
            }
        }
        for (var j = 0; j < players.length; j++) {
            if (startsWithIgnoreCase(players[j].name, target)) {
                return players[j];
            }
        }
        return null;
    }

    function findRankNameByGroupId(groupId) {
        for (var rankName in ranks) {
            if (ranks.hasOwnProperty(rankName) && String(ranks[rankName]) === String(groupId)) {
                return rankName;
            }
        }
        return null;
    }

    function rankGroupsOf(player) {
        var groupId = ranks[player.rank];
        return groupId ? [groupId] : [];
    }

    // Every server group ID a rank maps to. Sweeping ALL of these (instead of
    // only the stored rank's group) is what actually clears old ranks: the
    // stored rank can be empty or stale when the group was granted manually
    // or before the rank field was recorded.
    function allRankGroupIds() {
        var ids = [];
        for (var rankName in ranks) {
            if (ranks.hasOwnProperty(rankName)) {
                var id = String(ranks[rankName]);
                if (ids.indexOf(id) === -1) {
                    ids.push(id);
                }
            }
        }
        return ids;
    }

    function isRankName(name) {
        return ranks.hasOwnProperty(name);
    }

    function bestOnlineMatch(partial) {
        var term = String(partial || '').trim();
        if (!term) {
            return null;
        }
        var matches = searchClients(term, true, false, backend.getClients());
        if (!matches.length) {
            return null;
        }
        // Prefer exact name, then prefix match, then the closest (shortest) name.
        for (var i = 0; i < matches.length; i++) {
            if (equalsIgnoreCase(matches[i].name(), term)) {
                return matches[i];
            }
        }
        for (var j = 0; j < matches.length; j++) {
            if (startsWithIgnoreCase(matches[j].name(), term)) {
                return matches[j];
            }
        }
        var best = matches[0];
        for (var k = 1; k < matches.length; k++) {
            if (matches[k].name().length < best.name().length) {
                best = matches[k];
            }
        }
        return best;
    }

    function onlineClientByName(name) {
        var matches = searchClients(String(name || ''), false, false, backend.getClients());
        return matches.length ? matches[0] : null;
    }

    // ===== COMMAND HANDLING =====
    event.on('chat', function(ev) {
        if (ev.client.isSelf()) {
            return;
        }

        var text = String(ev.text || '').trim();

        // Taverne: !taverne or !taverne <message>
        var tavernePrefix = '!' + taverneName + ' ';
        if (text === '!' + taverneName || text.indexOf(tavernePrefix) === 0) {
            var taverneArgs = text === '!' + taverneName ? '' : text.substring(tavernePrefix.length);
            handleTaverneCommand(taverneArgs, ev);
            return;
        }

        // Roster commands: !roster <subcommand>
        var prefix = '!' + botName + ' ';
        if (text.indexOf(prefix) === 0) {
            var cmdText = text.substring(prefix.length);
            logMessage('ROSTER COMMAND from ' + ev.client.name() + ': ' + cmdText, 4);
            handleRosterCommand(cmdText, ev);
        }
    });

    function handleRosterCommand(args, ev) {
        var invoker = ev.client;
        var invokerIsLeadership = isLeadership(invoker);

        var invokerGroupIds = [];
        if (invoker && typeof invoker.getServerGroups === 'function') {
            var rawGroups = invoker.getServerGroups();
            for (var gi = 0; gi < rawGroups.length; gi++) {
                invokerGroupIds.push(rawGroups[gi].id());
            }
        }
        logMessage('AUTH CHECK: ' + invoker.name() + ' groups=[' + invokerGroupIds.join(',') + '] leadershipGroup=' + leadershipGroupId + ' >> leadership=' + invokerIsLeadership, 3);

        var parts = args.trim().split(/\s+/);
        var subCommand = parts[0] ? parts[0].toLowerCase() : '';

        // Free-text commands parse the name from the remainder (names may contain spaces).
        var rest = parts.slice(1).join(' ').trim();
        var restParts = parts.slice(1);

        if (subCommand === 'test') {
            invoker.chat('[RosterManager] v0.1.0 test OK' + (invokerIsLeadership ? ' — leadership' : ''));
            return;
        }

        if (subCommand === 'help') {
            displayHelp(ev);
            return;
        }

        // All other roster commands are leadership-only.
        if (!invokerIsLeadership) {
            invoker.chat('[RosterManager] Permission denied — leadership only');
            return;
        }

        if (subCommand === 'add') {
            if (!rest) {
                invoker.chat('Usage: !' + botName + ' add <name>');
                return;
            }
            addPlayer(rest, 'pending', ev);
            return;
        }

        if (subCommand === 'addintroduced') {
            if (!rest) {
                invoker.chat('Usage: !' + botName + ' addintroduced <name>');
                return;
            }
            addPlayer(rest, 'introduced', ev);
            return;
        }

        if (subCommand === 'introduced') {
            if (!rest) {
                invoker.chat('Usage: !' + botName + ' introduced <name>');
                return;
            }
            handleIntroduced(rest, ev);
            return;
        }

        if (subCommand === 'pending') {
            displayPending(ev);
            return;
        }

        if (subCommand === 'status') {
            displayRosterStatus(ev);
            return;
        }

        if (subCommand === 'info') {
            if (!rest) {
                invoker.chat('Usage: !' + botName + ' info <name>');
                return;
            }
            displayPlayerInfo(rest, ev);
            return;
        }

        if (subCommand === 'remove') {
            if (!rest) {
                invoker.chat('Usage: !' + botName + ' remove <name>');
                return;
            }
            handleRemovePlayer(rest, ev);
            return;
        }

        if (subCommand === 'assign') {
            if (!rest) {
                invoker.chat('Usage: !' + botName + ' assign <name>');
                return;
            }
            handleAssign(rest, ev);
            return;
        }

        if (subCommand === 'ranks' || subCommand === 'rank') {
            displayRankList(ev);
            return;
        }

        if (subCommand === 'rankup') {
            if (restParts.length < 2) {
                invoker.chat('Usage: !' + botName + ' rankup <name> <rank>');
                return;
            }
            // Names may contain spaces and the rank is trailing, so match the
            // longest known rank suffix ("John Smith Korporaal" -> name "John Smith").
            var split = splitNameAndRank(rest);
            if (!split) {
                var known = Object.keys(ranks).join(', ');
                invoker.chat('[RosterManager] Could not find a rank at the end of the command' + (known ? ' — known ranks: ' + known : ' — no ranks configured') + '. Usage: !' + botName + ' rankup <name> <rank>');
                return;
            }
            handleRankup(split.name, split.rank, ev);
            return;
        }

        if (subCommand === 'match') {
            if (!rest) {
                invoker.chat('Usage: !' + botName + ' match <partial name>');
                return;
            }
            handleMatch(rest, ev);
            return;
        }

        // Notes: note add <name> <text> / note delete <id>
        if (subCommand === 'note') {
            var noteAction = restParts[0] ? restParts[0].toLowerCase() : '';
            if (noteAction === 'add') {
                if (restParts.length < 3) {
                    invoker.chat('Usage: !' + botName + ' note add <name> <text>');
                    return;
                }
                var noteTarget = restParts[1];
                var noteText = restParts.slice(2).join(' ').trim();
                handleNoteAdd(noteTarget, noteText, ev);
                return;
            }
            if (noteAction === 'delete') {
                if (restParts.length < 2) {
                    invoker.chat('Usage: !' + botName + ' note delete <id>');
                    return;
                }
                handleNoteDelete(restParts[1], ev);
                return;
            }
            invoker.chat('Usage: !' + botName + ' note add <name> <text> | !' + botName + ' note delete <id>');
            return;
        }

        if (subCommand === 'notes') {
            if (!rest) {
                invoker.chat('Usage: !' + botName + ' notes <name>');
                return;
            }
            displayNotes(rest, ev);
            return;
        }

        invoker.chat('Unknown roster command. Usage: !' + botName + ' help');
    }

    // ===== ROSTER OPERATIONS =====
    function addPlayer(name, introStatus, ev) {
        var invoker = ev.client;
        var existing = findPlayer(name);
        if (existing) {
            invoker.chat('[RosterManager] Player already on roster: ' + existing.name);
            return;
        }

        var player = {
            name: name,
            introStatus: introStatus,
            rank: '',
            notes: [],
            createdAt: new Date().toISOString()
        };
        players.push(player);

        // If the player is already online on TeamSpeak, assign membership
        // (GoudGraaier) right away. Matroos is only granted when the player
        // holds NO other rank group yet — an existing rank is kept as-is and
        // recorded. Offline players stay roster-only (!roster assign later).
        var assigned = false;
        var client = onlineClientByName(name);
        var defaultRankId = ranks[DEFAULT_RANK];
        if (client && membershipGroupIds.length) {
            addToServerGroups(client, membershipGroupIds);
            assigned = true;
            if (defaultRankId) {
                var heldRankGroups = [];
                var allRankIds = allRankGroupIds();
                for (var ri = 0; ri < allRankIds.length; ri++) {
                    if (isMemberOfOne(client, [allRankIds[ri]])) {
                        heldRankGroups.push(allRankIds[ri]);
                    }
                }
                if (heldRankGroups.length) {
                    // Already carries a rank — keep it, just record it.
                    var existingRank = findRankNameByGroupId(heldRankGroups[0]);
                    if (existingRank) {
                        player.rank = existingRank;
                    }
                } else {
                    addToServerGroups(client, [defaultRankId]);
                    player.rank = DEFAULT_RANK;
                }
            }
        }

        if (persistenceInitialized) {
            saveData();
        }
        invoker.chat('[RosterManager] Added ' + name + '. Introduction status: ' + introStatus + '.' +
            (assigned ? ' Player is online — assigned ' + (player.rank || DEFAULT_RANK) + ' + membership groups.' : ''));
        logMessage('Player added: ' + name + ' (' + introStatus + ') by ' + invoker.name(), 3);
    }

    function handleIntroduced(name, ev) {
        var invoker = ev.client;
        var player = findPlayer(name);
        if (!player) {
            invoker.chat('[RosterManager] Player not found: ' + name);
            return;
        }
        if (player.introStatus === 'introduced') {
            invoker.chat('[RosterManager] ' + player.name + ' is already introduced');
            return;
        }
        player.introStatus = 'introduced';
        if (persistenceInitialized) {
            saveData();
        }
        invoker.chat('[RosterManager] ' + player.name + ' marked as introduced.');
    }

    function handleRemovePlayer(name, ev) {
        var invoker = ev.client;
        var player = findPlayer(name);
        if (!player) {
            invoker.chat('[RosterManager] Player not found: ' + name);
            return;
        }

        // Strip membership (GoudGraaier) and any rank server group while the
        // player is online. Offline players keep their groups — the next
        // assign/rankup will not apply, so leadership strips manually or
        // re-adds and removes them while online.
        var stripped = false;
        var client = onlineClientByName(player.name);
        if (client) {
            removeFromServerGroups(client, membershipGroupIds);
            removeFromServerGroups(client, allRankGroupIds());
            stripped = true;
        }

        for (var i = 0; i < players.length; i++) {
            if (players[i] === player) {
                players.splice(i, 1);
                break;
            }
        }
        if (persistenceInitialized) {
            saveData();
        }
        invoker.chat('[RosterManager] Removed ' + player.name + ' from the roster.' +
            (stripped ? ' Server groups stripped.' : ' WARNING: not online — TeamSpeak groups NOT stripped; remove them manually or remove them while online next time.'));
    }

    function handleAssign(name, ev) {
        var invoker = ev.client;
        var player = findPlayer(name);
        if (!player) {
            invoker.chat('[RosterManager] Player not found: ' + name);
            return;
        }

        var client = onlineClientByName(player.name);
        if (!client) {
            invoker.chat('[RosterManager] ' + player.name + ' is not online — connect them to TeamSpeak first, then assign.');
            return;
        }

        var groups = membershipGroupIds.slice();
        var rankGroups = rankGroupsOf(player);
        for (var i = 0; i < rankGroups.length; i++) {
            if (groups.indexOf(rankGroups[i]) === -1) {
                groups.push(rankGroups[i]);
            }
        }

        if (!groups.length) {
            invoker.chat('[RosterManager] No server groups configured');
            return;
        }

        addToServerGroups(client, groups);
        invoker.chat('[RosterManager] Assigned server groups to ' + player.name + ' (membership' + (rankGroups.length ? ' + rank ' + player.rank : '') + ').');
    }

    // "John Smith Korporaal" -> { name: "John Smith", rank: "Korporaal" }
    // by finding the longest trailing token sequence that is a configured rank.
    function splitNameAndRank(text) {
        var tokens = String(text || '').trim().split(/\s+/);
        for (var take = 1; take < tokens.length; take++) {
            var rankCandidate = tokens.slice(tokens.length - take).join(' ');
            var nameCandidate = tokens.slice(0, tokens.length - take).join(' ');
            if (!nameCandidate) {
                continue; // "!roster rankup Korporaal" has no player name — usage error
            }
            // Exact rank name first; then case-insensitive compare.
            if (ranks.hasOwnProperty(rankCandidate)) {
                return { name: nameCandidate, rank: rankCandidate };
            }
            for (var rankName in ranks) {
                if (ranks.hasOwnProperty(rankName) && equalsIgnoreCase(rankName, rankCandidate)) {
                    return { name: nameCandidate, rank: rankName };
                }
            }
        }
        return null;
    }

    function displayRankList(ev) {
        var invoker = ev.client;
        var names = Object.keys(ranks);
        if (!names.length) {
            invoker.chat('[RosterManager] No ranks configured');
            return;
        }
        var msg = '[RosterManager] RANKS (' + names.length + '):\n';
        for (var i = 0; i < names.length; i++) {
            msg += ' - ' + names[i] + ' = server group ' + ranks[names[i]] + '\n';
        }
        invoker.chat(msg);
    }

    function handleRankup(name, rankName, ev) {
        var invoker = ev.client;
        var player = findPlayer(name);
        if (!player) {
            invoker.chat('[RosterManager] Player not found: ' + name);
            return;
        }
        if (!isRankName(rankName)) {
            var known = Object.keys(ranks).join(', ');
            invoker.chat('[RosterManager] Unknown rank: ' + rankName + (known ? ' — known ranks: ' + known : ' — no ranks configured'));
            return;
        }

        var client = onlineClientByName(player.name);
        if (!client) {
            invoker.chat('[RosterManager] ' + player.name + ' is not online — ranks are changed on TeamSpeak; connect them first.');
            return;
        }

        // Remove ALL configured rank groups, not just the stored rank's group:
        // the stored rank may be empty or stale (group granted manually), and
        // TS3 shows the old rank otherwise.
        removeFromServerGroups(client, allRankGroupIds());
        player.rank = rankName;
        addToServerGroups(client, [ranks[rankName]]);
        if (persistenceInitialized) {
            saveData();
        }

        invoker.chat('[RosterManager] ' + player.name + ' rankup: old rank(s) removed, now ' + rankName + '.');
    }

    function handleMatch(partial, ev) {
        var invoker = ev.client;
        var client = bestOnlineMatch(partial);
        if (!client) {
            invoker.chat('[RosterManager] No online client matches: ' + partial);
            return;
        }
        invoker.chat('[RosterManager] Closest match: ' + client.name() + ' (id ' + client.id() + ')');
    }

    // ===== NOTES OPERATIONS =====
    function handleNoteAdd(name, text, ev) {
        var invoker = ev.client;
        var player = findPlayer(name);
        if (!player) {
            invoker.chat('[RosterManager] Player not found: ' + name);
            return;
        }
        if (!text) {
            invoker.chat('Usage: !' + botName + ' note add <name> <text>');
            return;
        }

        noteIdCounter++;
        var note = {
            id: noteIdCounter,
            text: text,
            createdAt: new Date().toISOString(),
            createdBy: invoker.name()
        };
        player.notes.push(note);
        if (persistenceInitialized) {
            saveData();
        }
        invoker.chat('[RosterManager] Note added for ' + player.name + '. ID: ' + note.id);
    }

    function handleNoteDelete(idText, ev) {
        var invoker = ev.client;
        var id = parseInt(idText, 10);
        if (isNaN(id)) {
            invoker.chat('[RosterManager] Invalid note ID: ' + idText);
            return;
        }
        for (var i = 0; i < players.length; i++) {
            var notes = players[i].notes;
            for (var j = 0; j < notes.length; j++) {
                if (parseInt(notes[j].id, 10) === id) {
                    var removed = notes.splice(j, 1)[0];
                    if (persistenceInitialized) {
                        saveData();
                    }
                    invoker.chat('[RosterManager] Note ' + id + ' deleted from ' + players[i].name + '.');
                    logMessage('Note deleted: #' + id + ' (' + removed.text + ') from ' + players[i].name + ' by ' + invoker.name(), 3);
                    return;
                }
            }
        }
        invoker.chat('[RosterManager] Note not found: ' + id);
    }

    // ===== DISPLAY FUNCTIONS =====
    function displayPending(ev) {
        var invoker = ev.client;
        var pending = [];
        for (var i = 0; i < players.length; i++) {
            if (players[i].introStatus === 'pending') {
                pending.push(players[i]);
            }
        }
        if (!pending.length) {
            invoker.chat('[RosterManager] No players awaiting introduction');
            return;
        }
        var msg = '[RosterManager] PENDING INTRO (' + pending.length + '):\n';
        for (var j = 0; j < pending.length; j++) {
            msg += ' - ' + pending[j].name + ' (added ' + formatDate(pending[j].createdAt) + ')\n';
        }
        invoker.chat(msg);
    }

    function displayRosterStatus(ev) {
        var invoker = ev.client;
        if (!players.length) {
            invoker.chat('[RosterManager] Roster is empty');
            return;
        }
        var msg = '[RosterManager] ROSTER (' + players.length + '):\n';
        for (var i = 0; i < players.length; i++) {
            var p = players[i];
            msg += (i + 1) + '. ' + p.name + ' | ' + p.introStatus + (p.rank ? ' | ' + p.rank : '') + '\n';
        }
        invoker.chat(msg);
    }

    function displayPlayerInfo(name, ev) {
        var invoker = ev.client;
        var player = findPlayer(name);
        if (!player) {
            invoker.chat('[RosterManager] Player not found: ' + name);
            return;
        }
        var msg = '[RosterManager] PLAYER INFO:\n';
        msg += 'Name: ' + player.name + '\n';
        msg += 'Intro: ' + player.introStatus + '\n';
        msg += 'Rank: ' + (player.rank || 'none') + '\n';
        msg += 'Added: ' + formatDate(player.createdAt) + '\n';
        msg += 'Notes: ' + (player.notes.length ? player.notes.length + ' (use !' + botName + ' notes ' + player.name + ')' : 'none');
        invoker.chat(msg);
    }

    function displayNotes(name, ev) {
        var invoker = ev.client;
        var player = findPlayer(name);
        if (!player) {
            invoker.chat('[RosterManager] Player not found: ' + name);
            return;
        }
        if (!player.notes.length) {
            invoker.chat('[RosterManager] No notes for ' + player.name);
            return;
        }
        var msg = '[RosterManager] NOTES for ' + player.name + ':\n';
        for (var i = 0; i < player.notes.length; i++) {
            var note = player.notes[i];
            msg += '#' + note.id + ' [' + formatDate(note.createdAt) + ' by ' + note.createdBy + '] ' + note.text + '\n';
        }
        invoker.chat(msg);
    }

    function displayHelp(ev) {
        var invoker = ev.client;
        var p = '!' + botName;
        var t = '!' + taverneName;

        var helpMsg = '[RosterManager] COMMANDS:\n' +
            p + ' help - Show this help message\n' +
            p + ' add <name> - Add player; auto-assigns groups if online (leadership)\n' +
            p + ' addintroduced <name> - Same as add, but marks them introduced (leadership)\n' +
            p + ' introduced <name> - Mark introduced (leadership)\n' +
            p + ' pending - Players awaiting intro (leadership)\n' +
            p + ' status - Show full roster (leadership)\n' +
            p + ' info <name> - Player details (leadership)\n' +
            p + ' remove <name> - Remove player (leadership)\n' +
            p + ' assign <name> - Assign server groups (player must be online)\n' +
            p + ' rankup <name> <rank> - Give a new rank (player must be online)\n' +
            p + ' match <partial> - Match closest online client\n' +
            p + ' ranks - Show configured ranks\n' +
            p + ' note add <name> <text> - Append a note (leadership)\n' +
            p + ' notes <name> - List notes with IDs (leadership)\n' +
            p + ' note delete <id> - Delete a note by ID (leadership)\n' +
            t + ' <message> - Post a message to the taverne\n' +
            t + ' help - Taverne help\n' +
            t + ' clear - Clear all taverne messages (leadership)';
        invoker.chat(helpMsg);
    }

    // ===== TAVERNE (MESSAGEBOARD) =====
    // Single-stage: !taverne <message> posts directly.
    function handleTaverneCommand(args, ev) {
        var invoker = ev.client;

        if (!messageboardEnabled) {
            invoker.chat('[RosterManager] Taverne is disabled');
            return;
        }

        args = String(args || '').trim();

        if (equalsIgnoreCase(args, 'help')) {
            displayTaverneHelp(ev);
            return;
        }

        if (equalsIgnoreCase(args, 'clear')) {
            if (!isLeadership(invoker)) {
                invoker.chat('[RosterManager] Permission denied — leadership only');
                return;
            }
            var count = messages.length;
            messages = [];
            if (persistenceInitialized) {
                saveData();
            }
            updateTaverneDescription();
            invoker.chat('[RosterManager] Taverne cleared (' + (count === 1 ? '1 message' : count + ' messages') + ' removed).');
            return;
        }

        if (!args) {
            displayTaverneHelp(ev);
            return;
        }

        // Direct post: !taverne <message>
        postTaverneMessage(args, invoker);
    }

    function displayTaverneHelp(ev) {
        var invoker = ev.client;
        var t = '!' + taverneName;
        invoker.chat('[RosterManager] TAVERNE COMMANDS:\n' +
            t + ' <message> - Post a message to the taverne\n' +
            t + ' clear - Clear all taverne messages (leadership)\n' +
            t + ' help - Show this help message');
    }

    function postTaverneMessage(text, invoker) {
        var entry = {
            text: text,
            postedBy: invoker.name(),
            postedAt: new Date().toISOString()
        };
        messages.push(entry);
        if (persistenceInitialized) {
            saveData();
        }
        updateTaverneDescription();
        invoker.chat('[RosterManager] Message posted to taverne.');
        logMessage('Taverne message posted by ' + invoker.name(), 3);
    }

    function updateTaverneDescription() {
        if (!messageboardEnabled) {
            return;
        }
        var channel = backend.getChannelByID(messageboardChannelId);
        if (!channel) {
            if (messageboardChannelId) {
                logMessage('Taverne channel ' + messageboardChannelId + ' not found', 2);
            }
            return;
        }

        var shown = messages.slice(-maxShownMessages).reverse(); // newest at top
        var board = '';
        if (!shown.length) {
            board = '[center]No messages yet[/center]';
        } else {
            for (var i = 0; i < shown.length; i++) {
                var m = shown[i];
                board += '[b]' + m.postedBy + '[/b] (' + formatDate(m.postedAt) + '): ' + m.text + '\n';
            }
            if (messages.length > shown.length) {
                board += '... and ' + (messages.length - shown.length) + ' older messages';
            }
        }

        var description = '[center][b][color=#FFD700]' + messageboardTitle + '[/color][/b][/center]\n' + board;
        try {
            channel.setDescription(description);
        } catch (e) {
            logMessage('ERROR updating taverne channel description: ' + e.message, 1);
        }
    }

    // ===== UTILITY FUNCTIONS =====
    function formatDate(iso) {
        try {
            return new Date(iso).toLocaleDateString();
        } catch (e) {
            return String(iso || '').split('T')[0];
        }
    }
});
