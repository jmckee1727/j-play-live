// interpret.js -- reads a clue the way a contestant does, to decide how a
// response should be phrased: "Who is", "Who are", "What is" or "What are".
//
// The strongest signal in a Jeopardy! clue is the noun after "this" or
// "these" ("this CIA agent", "these third molars", "this 2-word term"): it
// names the kind of thing the response is. So:
//
//   1. Find the first "this/these/those ..." phrase and its head noun.
//      A person noun there (agent, character, god, president, band...) means
//      "Who"; anything else means "What", even in a people-ish category
//      ("AUTHORS & THEIR WORKS" with "this novel" is still "What").
//   2. With no such phrase, pronouns decide ("he", "she", "his", "for him").
//   3. Failing that, the category name decides (U.S. PRESIDENTS, AUTHORS,
//      FICTIONAL CHARACTERS...).
//   4. Plural ("are") comes from "these/those", a group noun ("this band",
//      "this ethnic group") with a plural-looking response, a clue that
//      starts with "They", or an irregular-plural response (teeth, elves).

var JPInterpret = (function() {
    'use strict';

    const PERSON_NOUNS = [
        // generic
        'man', 'woman', 'person', 'guy', 'gal', 'lady', 'gentleman', 'boy', 'girl', 'child', 'kid', 'teen', 'teenager', 'lad', 'lass', 'fellow', 'chap', 'dude',
        'figure', 'individual', 'native', 'resident', 'citizen', 'immigrant', 'refugee', 'pioneer', 'settler', 'colonist', 'frontiersman', 'patriot', 'loyalist',
        'character', 'droid', 'robot', 'android', 'cyborg', 'hero', 'heroine', 'villain', 'protagonist', 'antagonist', 'narrator', 'sidekick', 'superhero', 'supervillain', 'mascot', 'legend', 'icon', 'celebrity', 'star', 'superstar', 'idol', 'darling', 'sweetheart', 'heartthrob',
        'winner', 'nominee', 'laureate', 'honoree', 'recipient', 'medalist', 'champion', 'champ', 'titleholder', 'mvp', 'contestant', 'competitor', 'finalist', 'runner-up', 'victor', 'loser', 'underdog', 'favorite', 'rookie', 'veteran', 'all-star', 'olympian', 'hall of famer',
        // family & titles
        'husband', 'wife', 'mother', 'father', 'mom', 'dad', 'son', 'daughter', 'sister', 'brother', 'sibling', 'uncle', 'aunt', 'nephew', 'niece', 'cousin', 'grandson', 'granddaughter', 'grandfather', 'grandmother', 'grandpa', 'grandma', 'ancestor', 'descendant', 'heir', 'heiress', 'widow', 'widower', 'bride', 'groom', 'fiancé', 'fiancée', 'spouse', 'partner', 'twin', 'orphan', 'foundling', 'stepfather', 'stepmother', 'stepson', 'stepdaughter', 'in-law', 'patriarch', 'matriarch',
        'king', 'queen', 'prince', 'princess', 'emperor', 'empress', 'czar', 'tsar', 'tsarina', 'czarina', 'kaiser', 'pharaoh', 'sultan', 'sheikh', 'shah', 'khan', 'emir', 'caliph', 'rajah', 'maharaja', 'maharani', 'monarch', 'sovereign', 'ruler', 'regent', 'consort', 'dictator', 'tyrant', 'despot', 'strongman', 'leader', 'chief', 'chieftain', 'warlord', 'lord', 'lady', 'baron', 'baroness', 'count', 'countess', 'duke', 'duchess', 'earl', 'marquis', 'marquess', 'viscount', 'knight', 'dame', 'squire', 'nobleman', 'noblewoman', 'aristocrat', 'courtier', 'page',
        // government & law
        'president', 'vice president', 'veep', 'first lady', 'senator', 'congressman', 'congresswoman', 'representative', 'legislator', 'lawmaker', 'politician', 'statesman', 'stateswoman', 'candidate', 'incumbent', 'governor', 'mayor', 'alderman', 'councilman', 'councilwoman', 'commissioner', 'secretary', 'chancellor', 'premier', 'prime minister', 'minister', 'ambassador', 'diplomat', 'envoy', 'delegate', 'speaker', 'whip', 'justice', 'judge', 'magistrate', 'lawyer', 'attorney', 'prosecutor', 'solicitor', 'barrister', 'counsel', 'juror', 'sheriff', 'marshal', 'constable', 'deputy', 'detective', 'inspector', 'investigator', 'officer', 'cop', 'policeman', 'policewoman', 'agent', 'spy', 'operative', 'informant', 'mole', 'defector', 'whistleblower', 'lobbyist', 'activist', 'abolitionist', 'suffragist', 'suffragette', 'reformer', 'revolutionary', 'rebel', 'insurgent', 'dissident', 'protester', 'martyr', 'founder', 'co-founder', 'framer', 'signer', 'delegate',
        // military
        'soldier', 'warrior', 'fighter', 'general', 'admiral', 'commodore', 'commander', 'captain', 'major', 'colonel', 'lieutenant', 'sergeant', 'corporal', 'private', 'brigadier', 'marshal', 'field marshal', 'conqueror', 'crusader', 'knight', 'samurai', 'shogun', 'gladiator', 'centurion', 'legionnaire', 'mercenary', 'guerrilla', 'partisan', 'pilot', 'aviator', 'ace', 'astronaut', 'cosmonaut', 'sailor', 'seaman', 'mariner', 'navigator', 'explorer', 'adventurer', 'mountaineer', 'climber', 'conquistador', 'viking', 'pirate', 'buccaneer', 'privateer', 'corsair', 'outlaw', 'bandit', 'gunslinger', 'gunfighter', 'cowboy', 'cowgirl', 'lawman', 'ranger', 'scout', 'trapper', 'hunter', 'guide',
        // arts & letters
        'author', 'writer', 'novelist', 'poet', 'playwright', 'dramatist', 'screenwriter', 'scriptwriter', 'essayist', 'satirist', 'humorist', 'biographer', 'memoirist', 'diarist', 'lyricist', 'librettist', 'songwriter', 'journalist', 'reporter', 'columnist', 'correspondent', 'anchor', 'anchorman', 'anchorwoman', 'newsman', 'broadcaster', 'commentator', 'critic', 'reviewer', 'editor', 'publisher', 'cartoonist', 'illustrator', 'animator', 'artist', 'painter', 'sculptor', 'muralist', 'printmaker', 'photographer', 'architect', 'designer', 'couturier', 'composer', 'conductor', 'maestro', 'musician', 'singer', 'vocalist', 'crooner', 'rapper', 'mc', 'dj', 'guitarist', 'bassist', 'drummer', 'pianist', 'violinist', 'cellist', 'saxophonist', 'trumpeter', 'organist', 'harpist', 'flutist', 'tenor', 'soprano', 'baritone', 'diva', 'bandleader', 'frontman', 'frontwoman', 'actor', 'actress', 'thespian', 'comedian', 'comedienne', 'comic', 'entertainer', 'performer', 'showman', 'impresario', 'director', 'producer', 'filmmaker', 'auteur', 'cinematographer', 'choreographer', 'dancer', 'ballerina', 'danseur', 'magician', 'illusionist', 'ventriloquist', 'puppeteer', 'clown', 'juggler', 'acrobat', 'stuntman', 'model', 'supermodel', 'host', 'hostess', 'emcee', 'announcer', 'personality', 'influencer', 'youtuber', 'podcaster', 'blogger', 'streamer',
        // science & thought
        'scientist', 'physicist', 'chemist', 'biologist', 'geologist', 'astronomer', 'astrophysicist', 'cosmologist', 'mathematician', 'statistician', 'economist', 'psychologist', 'psychiatrist', 'sociologist', 'anthropologist', 'archaeologist', 'paleontologist', 'botanist', 'zoologist', 'naturalist', 'ecologist', 'geneticist', 'microbiologist', 'virologist', 'epidemiologist', 'inventor', 'engineer', 'programmer', 'coder', 'hacker', 'developer', 'technologist', 'futurist', 'philosopher', 'theologian', 'thinker', 'scholar', 'academic', 'professor', 'lecturer', 'teacher', 'educator', 'tutor', 'mentor', 'historian', 'linguist', 'lexicographer', 'grammarian', 'etymologist', 'cartographer', 'geographer', 'physician', 'doctor', 'surgeon', 'nurse', 'dentist', 'pharmacist', 'veterinarian', 'vet', 'therapist', 'healer', 'midwife', 'nutritionist', 'dietitian', 'chef', 'cook', 'baker', 'pastry chef', 'restaurateur', 'sommelier', 'bartender', 'brewer', 'vintner', 'distiller',
        // religion & myth
        'god', 'goddess', 'deity', 'demigod', 'titan', 'giant', 'prophet', 'apostle', 'disciple', 'evangelist', 'saint', 'martyr', 'pope', 'pontiff', 'cardinal', 'archbishop', 'bishop', 'priest', 'monk', 'friar', 'abbot', 'abbess', 'nun', 'rabbi', 'imam', 'mullah', 'ayatollah', 'guru', 'swami', 'lama', 'monk', 'preacher', 'pastor', 'reverend', 'minister', 'chaplain', 'missionary', 'pilgrim', 'mystic', 'sage', 'oracle', 'seer', 'wizard', 'witch', 'sorcerer', 'sorceress', 'enchantress', 'magician', 'shaman', 'druid', 'angel', 'archangel', 'demon', 'devil', 'messiah', 'savior', 'patron saint', 'reformer', 'heretic',
        // business & sport
        'businessman', 'businesswoman', 'tycoon', 'magnate', 'mogul', 'baron', 'industrialist', 'financier', 'banker', 'investor', 'broker', 'trader', 'merchant', 'entrepreneur', 'executive', 'ceo', 'chairman', 'chairwoman', 'boss', 'owner', 'proprietor', 'billionaire', 'millionaire', 'philanthropist', 'benefactor', 'patron', 'heir', 'athlete', 'player', 'ballplayer', 'batter', 'hitter', 'slugger', 'pitcher', 'hurler', 'catcher', 'shortstop', 'infielder', 'outfielder', 'quarterback', 'qb', 'receiver', 'running back', 'linebacker', 'lineman', 'kicker', 'punter', 'goalie', 'goalkeeper', 'goaltender', 'striker', 'midfielder', 'defender', 'forward', 'center', 'guard', 'point guard', 'rebounder', 'dunker', 'shooter', 'sprinter', 'runner', 'marathoner', 'hurdler', 'jumper', 'vaulter', 'thrower', 'swimmer', 'diver', 'gymnast', 'skater', 'skier', 'snowboarder', 'surfer', 'skateboarder', 'cyclist', 'racer', 'driver', 'jockey', 'wrestler', 'grappler', 'boxer', 'pugilist', 'heavyweight', 'golfer', 'tennis player', 'bowler', 'coach', 'manager', 'skipper', 'trainer', 'referee', 'umpire', 'commissioner', 'owner', 'scout', 'fan',
        // misc occupations
        'farmer', 'rancher', 'miner', 'blacksmith', 'carpenter', 'mason', 'tailor', 'seamstress', 'cobbler', 'butcher', 'barber', 'hairdresser', 'stylist', 'jeweler', 'watchmaker', 'clockmaker', 'gunsmith', 'locksmith', 'plumber', 'electrician', 'mechanic', 'welder', 'machinist', 'craftsman', 'artisan', 'potter', 'weaver', 'glassblower', 'printer', 'typesetter', 'librarian', 'archivist', 'curator', 'clerk', 'accountant', 'auditor', 'actuary', 'secretary', 'receptionist', 'assistant', 'aide', 'butler', 'maid', 'servant', 'valet', 'footman', 'nanny', 'governess', 'housekeeper', 'gardener', 'groundskeeper', 'janitor', 'custodian', 'doorman', 'bellhop', 'porter', 'chauffeur', 'cabbie', 'trucker', 'conductor', 'engineer', 'fireman', 'firefighter', 'paramedic', 'lifeguard', 'guard', 'watchman', 'sentry', 'jailer', 'warden', 'inmate', 'prisoner', 'convict', 'criminal', 'crook', 'thief', 'burglar', 'robber', 'swindler', 'con man', 'forger', 'counterfeiter', 'smuggler', 'bootlegger', 'gangster', 'mobster', 'godfather', 'don', 'hitman', 'assassin', 'killer', 'murderer', 'poisoner', 'kidnapper', 'hijacker', 'terrorist', 'traitor', 'turncoat', 'deserter', 'fugitive', 'suspect', 'victim', 'survivor', 'witness', 'hostage', 'captive', 'slave', 'serf', 'peasant', 'commoner', 'beggar', 'vagabond', 'hobo', 'hermit', 'recluse', 'loner', 'eccentric', 'genius', 'prodigy', 'polymath', 'savant', 'expert', 'authority', 'guru', 'pundit', 'sage', 'mentor', 'coach', 'guide',
        'member', 'sleuth', 'gumshoe', 'mate', 'teammate', 'classmate', 'roommate', 'colleague', 'rival', 'opponent', 'foe', 'enemy', 'nemesis', 'ally', 'friend', 'buddy', 'pal', 'companion', 'lover', 'mistress', 'beau', 'suitor', 'admirer', 'follower', 'believer', 'convert', 'pupil', 'student', 'graduate', 'alumnus', 'alumna', 'dropout', 'employee', 'worker', 'laborer', 'staffer', 'intern', 'apprentice', 'journeyman', 'master', 'specialist', 'consultant', 'advisor', 'adviser', 'counselor', 'official', 'bureaucrat', 'administrator', 'supervisor', 'foreman', 'overseer', 'keeper', 'guest', 'visitor', 'tourist', 'traveler', 'passenger', 'rider', 'commuter', 'pedestrian', 'spectator', 'viewer', 'listener', 'reader', 'subscriber', 'customer', 'client', 'patient', 'casualty', 'bystander', 'neighbor', 'stranger', 'newcomer', 'outsider', 'insider', 'elder', 'youngster', 'baby', 'infant', 'toddler', 'adult', 'retiree', 'pensioner', 'bachelor', 'bachelorette', 'spinster', 'maiden', 'sinner', 'atheist', 'agnostic', 'skeptic', 'cynic', 'optimist', 'pessimist', 'idealist', 'realist', 'romantic', 'dreamer', 'visionary', 'moderate', 'liberal', 'conservative', 'radical', 'extremist', 'fanatic', 'zealot', 'nationalist', 'socialist', 'communist', 'capitalist', 'anarchist', 'libertarian', 'democrat', 'republican', 'federalist', 'whig', 'tory', 'populist', 'progressive', 'reactionary', 'unionist', 'secessionist', 'confederate', 'yankee', 'yank', 'brit', 'briton', 'aussie', 'kiwi', 'canuck', 'scot', 'dane', 'swede', 'finn', 'norwegian', 'spaniard', 'italian', 'greek', 'turk', 'russian', 'pole', 'czech', 'hungarian', 'austrian', 'egyptian', 'israeli', 'arab', 'persian', 'iranian', 'indian', 'korean', 'thai', 'filipino', 'australian', 'mexican', 'cuban', 'brazilian', 'argentine', 'chilean', 'peruvian', 'colombian', 'canadian', 'american', 'texan', 'californian', 'floridian', 'hawaiian', 'alaskan', 'virginian', 'bostonian', 'chicagoan', 'parisian', 'londoner', 'athenian', 'spartan', 'trojan', 'mongol', 'hun', 'goth', 'vandal', 'celt', 'gaul', 'saxon', 'norman', 'aztec', 'inca', 'apache', 'cherokee', 'navajo', 'comanche', 'nazi', 'fascist', 'bolshevik', 'menshevik', 'jacobin', 'royalist', 'cavalier', 'roundhead', 'puritan', 'quaker', 'shaker', 'mormon', 'jesuit', 'franciscan', 'benedictine', 'dominican', 'lutheran', 'calvinist', 'methodist', 'baptist', 'catholic', 'protestant', 'anglican', 'episcopalian', 'presbyterian', 'muslim', 'hindu', 'buddhist', 'sikh', 'jain', 'jew', 'christian', 'pagan', 'druid',
    ];
    const GROUP_NOUNS = [ 'band', 'group', 'duo', 'trio', 'quartet', 'quintet', 'sextet', 'ensemble', 'team', 'squad', 'couple', 'pair', 'twins', 'brothers', 'sisters', 'siblings', 'family', 'dynasty', 'clan', 'tribe', 'people', 'peoples', 'race', 'nation', 'gang', 'crew', 'cast', 'troupe', 'company', 'orchestra', 'choir', 'chorus', 'army', 'order', 'sect', 'cult', 'movement', 'party', 'firm', 'partners', 'founders', 'members', 'inhabitants', 'natives', 'settlers', 'invaders', 'conquerors', 'explorers', 'rulers', 'kings', 'queens', 'presidents', 'leaders', 'gods', 'goddesses', 'characters', 'heroes', 'villains', 'authors', 'writers', 'poets', 'artists', 'painters', 'composers', 'musicians', 'singers', 'actors', 'players', 'athletes', 'champions', 'winners', 'scientists', 'inventors', 'philosophers', 'saints', 'apostles', 'disciples', 'knights', 'warriors', 'soldiers', 'pirates', 'outlaws', 'spies', 'agents', 'astronauts', 'pioneers' ];
    // Group nouns that are made of people (so "Who are"); the rest are things.
    const PEOPLE_GROUPS = [ 'band', 'group', 'duo', 'trio', 'quartet', 'quintet', 'sextet', 'ensemble', 'team', 'squad', 'couple', 'pair', 'twins', 'brothers', 'sisters', 'siblings', 'family', 'dynasty', 'clan', 'tribe', 'people', 'peoples', 'gang', 'crew', 'cast', 'troupe', 'orchestra', 'choir', 'chorus', 'partners', 'founders', 'members', 'inhabitants', 'natives', 'settlers', 'invaders', 'conquerors', 'explorers', 'rulers', 'kings', 'queens', 'presidents', 'leaders', 'gods', 'goddesses', 'characters', 'heroes', 'villains', 'authors', 'writers', 'poets', 'artists', 'painters', 'composers', 'musicians', 'singers', 'actors', 'players', 'athletes', 'champions', 'winners', 'scientists', 'inventors', 'philosophers', 'saints', 'apostles', 'disciples', 'knights', 'warriors', 'soldiers', 'pirates', 'outlaws', 'spies', 'agents', 'astronauts', 'pioneers', 'sect', 'order', 'army', 'firm', 'company' ];
    const IRREGULAR_PLURALS = [ 'teeth', 'feet', 'geese', 'mice', 'lice', 'men', 'women', 'children', 'people', 'oxen', 'dice', 'elves', 'dwarves', 'dwarfs', 'wolves', 'knives', 'leaves', 'lives', 'wives', 'halves', 'calves', 'loaves', 'thieves', 'shelves', 'selves', 'hooves', 'fungi', 'cacti', 'alumni', 'stimuli', 'bacteria', 'phenomena', 'criteria', 'data', 'media', 'larvae', 'antennae', 'vertebrae', 'nebulae', 'series', 'species', 'sheep', 'deer', 'moose', 'fish', 'aircraft', 'salmon', 'trout', 'bison', 'swine', 'offspring', 'pants', 'scissors', 'glasses', 'jeans', 'shorts', 'trousers', 'tweezers', 'pliers', 'binoculars', 'headphones', 'stairs', 'thanks', 'clothes', 'goods', 'remains' ];

    const CATEGORY_PEOPLE_RE = /\b(PEOPLE|WOMEN|MEN|FOLKS|GUYS|GALS|LADIES|GENTLEMEN|AUTHORS|WRITERS|NOVELISTS|POETS|PLAYWRIGHTS|DRAMATISTS|ESSAYISTS|JOURNALISTS|PRESIDENTS|VICE PRESIDENTS|FIRST LADIES|LEADERS|RULERS|KINGS|QUEENS|MONARCHS|ROYALS|ROYALTY|EMPERORS|PHARAOHS|CZARS|TSARS|DICTATORS|SENATORS|GOVERNORS|MAYORS|POLITICIANS|STATESMEN|FOUNDING FATHERS|GENERALS|ADMIRALS|SOLDIERS|WARRIORS|EXPLORERS|INVENTORS|SCIENTISTS|PHYSICISTS|CHEMISTS|BIOLOGISTS|MATHEMATICIANS|ASTRONOMERS|ECONOMISTS|PHILOSOPHERS|THINKERS|HISTORIANS|COMPOSERS|CONDUCTORS|MUSICIANS|SINGERS|SONGWRITERS|RAPPERS|DIVAS|BANDS|GROUPS|DUOS|ACTORS|ACTRESSES|STARS|CELEBRITIES|CELEBS|COMEDIANS|COMICS|DIRECTORS|FILMMAKERS|PRODUCERS|ARTISTS|PAINTERS|SCULPTORS|ARCHITECTS|DESIGNERS|PHOTOGRAPHERS|CARTOONISTS|ATHLETES|PLAYERS|QUARTERBACKS|PITCHERS|SLUGGERS|BOXERS|GOLFERS|OLYMPIANS|CHAMPIONS|CHAMPS|MVPS|COACHES|MANAGERS|CHARACTERS|HEROES|HEROINES|VILLAINS|SUPERHEROES|DETECTIVES|SPIES|OUTLAWS|PIRATES|GANGSTERS|CRIMINALS|GODS|GODDESSES|DEITIES|SAINTS|POPES|PROPHETS|APOSTLES|ANGELS|WHO'S WHO|WHO|NAMES? IN THE NEWS|NOTABLE NAMES|FAMOUS NAMES|BIOGRAPHY|BIOGRAPHIES|BORN IN|DIED IN|NOBEL LAUREATES|LAUREATES|HALL OF FAME|HALL OF FAMERS|CHEFS|DOCTORS|NURSES|TEACHERS|LAWYERS|JUDGES|JUSTICES|CEOS|BILLIONAIRES|TYCOONS|ENTREPRENEURS|FOUNDERS|HOSTS|ANCHORS|MODELS|DANCERS|ASTRONAUTS|AVIATORS|PILOTS|SPOUSES|WIVES|HUSBANDS|MOTHERS|FATHERS|SONS|DAUGHTERS|BROTHERS|SISTERS|TWINS|SIBLINGS|FAMILIES|DYNASTIES|COUPLES)\b/i;
    // Things, not people: when the this-noun is one of these the answer is a "What".
    const THING_NOUNS_RE = /^(film|movie|flick|novel|book|play|musical|opera|operetta|ballet|symphony|concerto|sonata|song|single|hit|tune|album|record|lp|ep|show|series|sitcom|drama|comedy|program|episode|poem|sonnet|epic|painting|portrait|sculpture|statue|monument|building|tower|bridge|dam|canal|road|street|avenue|highway|railway|railroad|city|town|village|capital|state|province|county|country|nation|kingdom|empire|republic|island|peninsula|continent|region|area|land|territory|colony|river|lake|sea|ocean|bay|gulf|strait|channel|mountain|peak|range|volcano|desert|forest|jungle|park|valley|canyon|plateau|basin|cave|word|term|phrase|expression|idiom|slang|noun|verb|adjective|adverb|prefix|suffix|letter|abbreviation|acronym|initialism|name|nickname|title|surname|language|dialect|alphabet|number|numeral|date|year|decade|century|era|age|period|day|month|holiday|festival|event|battle|war|revolution|treaty|act|law|amendment|bill|case|doctrine|policy|plan|program|project|mission|company|corporation|brand|product|chain|store|restaurant|drink|cocktail|beverage|dish|food|fruit|vegetable|spice|herb|dessert|cheese|wine|beer|liquor|animal|mammal|bird|fish|reptile|insect|bug|creature|beast|plant|tree|flower|element|compound|mineral|metal|gas|chemical|molecule|particle|planet|moon|star|galaxy|constellation|comet|asteroid|organ|bone|muscle|gland|disease|disorder|condition|syndrome|virus|bacterium|vitamin|drug|medication|device|gadget|machine|tool|instrument|weapon|vehicle|car|ship|boat|plane|aircraft|train|game|sport|position|team name|toy|hobby|dance|style|genre|movement|school|theory|law|principle|concept|idea|process|method|technique|unit|measure|currency|coin|color|shape|pattern|material|fabric|garment|shoe|hat|object|thing|item|substance|body|structure|feature|part|piece|type|kind|sort|variety|breed|race|species|genus|family)$/i;

    function stripHtml(s) {
        return String(s || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
    }

    function isPersonWord(w) {
        w = w.toLowerCase().replace(/[^a-z' -]/g, '');
        if (!w) return false;
        if (PERSON_NOUNS.indexOf(w) >= 0) return true;
        // plural forms
        if (w.endsWith('s') && PERSON_NOUNS.indexOf(w.slice(0, -1)) >= 0) return true;
        if (w.endsWith('es') && PERSON_NOUNS.indexOf(w.slice(0, -2)) >= 0) return true;
        if (w.endsWith('men') && PERSON_NOUNS.indexOf(w.slice(0, -3) + 'man') >= 0) return true;
        // demonyms and roles built with -man / -woman / -person
        if (/^[a-z-]+(man|woman|person)$/.test(w) && w.length > 5 && !/^(human|roman|german|ottoman|caiman|talisman|dolman|shaman)$/.test(w)) return true;
        return false;
    }
    // Organizations and classes: a single thing even though made of many ("this party", "this race").
    const ORG_NOUNS = [ 'party', 'company', 'corporation', 'firm', 'army', 'navy', 'order', 'sect', 'cult', 'movement', 'nation', 'race', 'species', 'breed', 'genus', 'league', 'club', 'church', 'school', 'college', 'university', 'empire', 'kingdom', 'government', 'agency', 'bureau', 'department', 'committee', 'commission', 'council', 'board', 'jury', 'court', 'senate', 'congress', 'parliament', 'union', 'guild', 'alliance', 'coalition', 'federation', 'association', 'organization', 'foundation', 'institute', 'society', 'network', 'studio', 'label', 'franchise', 'conglomerate', 'chain', 'brand', 'regiment', 'battalion', 'legion', 'fleet', 'squadron', 'division', 'corps', 'force', 'militia', 'gang' ];
    function isPeopleGroup(w) { return PEOPLE_GROUPS.indexOf(w.toLowerCase()) >= 0; }
    function isOrg(w) { return ORG_NOUNS.indexOf(w.toLowerCase()) >= 0; }
    function isGroup(w) { return isPeopleGroup(w) || isOrg(w); }
    const TITLE_CATEGORY_RE = /(MOVIE|FILM|NOVEL|BOOK|PLAY|MUSICAL|OPERA|SONG|ALBUM|\bTV\b|TELEVISION|SHOW|SITCOM|SERIES|TITLE|LITERATURE|SHAKESPEARE|POEM|POETRY|PAINTING|SCULPTURE|RECAP|PLOT|SUMMAR|SEQUEL|BEST PICTURE|BROADWAY|CINEMA|HOLLYWOOD|BOX OFFICE|BESTSELLER|CLASSICS|WORKS|BY SONGS|LYRICS)/i;

    const STOP_RE = /^(the|a|an|is|was|are|were|be|been|being|has|had|have|did|does|do|who|whom|whose|that|which|what|where|when|while|if|than|then|so|and|or|but|nor|of|in|on|at|to|for|from|with|by|as|into|onto|over|under|about|after|before|during|through|until|upon|out|up|down|off|also|once|now|later|still|just|only|not|no|there|here|it|its|it's|he|she|they|his|her|their|him|them|you|your|we|our|i|my|me|--|-|—)$/i;

    // Every "this/these/those ..." phrase in the clue, with the words that
    // follow it up to a stop word (numbers are skipped, possessives ignored).
    function demonstrativePhrases(text) {
        let out = [ ], re = /\b(this|these|those)\b/gi, m;
        while ((m = re.exec(text)) !== null) {
            let before = text.slice(Math.max(0, m.index - 8), m.index);
            let rest = text.slice(m.index + m[0].length).split(/[.;:!?]/)[0];
            let words = rest.split(/\s+/).filter(Boolean);
            let span = [ ];
            for (let w of words) {
                let clean = w.replace(/^[("'\[]+|[)"',\]]+$/g, '');
                if (!clean) break;
                if (/^\d[\d,.-]*(st|nd|rd|th)?$/.test(clean)) { if (/[,;:!?]$/.test(w)) break; continue; }
                if (STOP_RE.test(clean)) break;
                if (/[a-z]('s|s')$/i.test(clean)) { span.push(clean.replace(/('s|s')$/i, '')); break; }   // "this film's heroine": the film
                span.push(clean);
                if (span.length >= 6 || /[,;:!?]$/.test(w)) break;
            }
            out.push({ det: m[1].toLowerCase(), words: span, oneOf: /one of\s*$/i.test(before) });
        }
        return out;
    }

    function looksPlural(answer) {
        let a = answer.toLowerCase().replace(/^(the|a|an)\s+/, '').trim();
        let last = a.split(/\s+/).pop() || '';
        if (IRREGULAR_PLURALS.indexOf(last) >= 0) return true;
        if (/[^s]s$/.test(last) && !/(ss|us|is|os|ness|ics|series)$/.test(last) && last.length > 3) return true;
        return false;
    }

    // Main entry. clue: { category, clueText, answer } (plain text or HTML).
    // Returns { who, plural, phrase: 'Who is'|'Who are'|'What is'|'What are', reason }
    function analyze(clue) {
        let cat = stripHtml(clue.category || '');
        let text = stripHtml(clue.clueText || '');
        let answer = stripHtml(clue.answer || '');
        let noQuotes = text.replace(/"[^"]*"/g, ' ');           // pronouns inside quoted titles don't count
        let who = false, plural = false, reason = '';
        let peopleCat = CATEGORY_PEOPLE_RE.test(cat), titleCat = TITLE_CATEGORY_RE.test(cat);
        let pronoun = /\b(he|she|his|her|him|himself|herself)\b/i.test(noQuotes);

        let demos = demonstrativePhrases(text);
        let chosen = null, personHead = null, groupHead = null, thingHead = null, order = [ ];
        for (let d of demos) {
            let ws = d.words.map(function(w) { return w.toLowerCase(); });
            let typed = ws.map(function(w) { return isGroup(w) ? 'g' : isPersonWord(w) ? 'p' : THING_NOUNS_RE.test(w) ? 't' : null; });
            let i = typed.findIndex(function(x) { return x; });
            if (i < 0) continue;
            // "Baker Street sleuth", "title character": take the last noun of the run.
            let j = i;
            while (j + 1 < ws.length && typed[j + 1]) j++;
            let head = ws[j], kind = typed[j];
            chosen = d; order = ws;
            personHead = kind == 'p' ? head : null;
            groupHead = kind == 'g' ? head : null;
            thingHead = kind == 't' ? head : null;
            // Possessive-free compounds like "band member": person wins over group when adjacent.
            if (kind == 'g' && j > i && typed[j] == 'g' && typed[j - 1] == 'p') { personHead = null; }
            break;
        }

        if (chosen) {
            if (groupHead) {
                if (isPeopleGroup(groupHead)) {
                    who = true;
                    plural = chosen.det != 'this' || looksPlural(answer) || /^the\s/i.test(answer);
                } else {
                    who = false;
                    plural = chosen.det != 'this' || looksPlural(answer);
                }
                reason = 'group noun "' + groupHead + '"';
            } else if (personHead) {
                who = true;
                plural = chosen.det != 'this' || (/s$/.test(personHead) && looksPlural(answer));
                reason = 'person noun "' + personHead + '"';
            } else {
                who = false;
                plural = chosen.det != 'this';
                reason = 'thing noun "' + thingHead + '"';
            }
        } else {
            // No typed noun after any "this". Use pronouns, then the category.
            // In a titles category ("SONGS", "MOVIES") a "he"/"she" clue is
            // usually about the work ("She sang it in 1985"), so the pronoun
            // only counts there when nothing in the clue points at a thing:
            // "He sang 'Folsom Prison Blues'" names the song, so the person is
            // the response.
            let thingRef = /\b(it|its|itself|this|these|those|here|title)\b/i.test(noQuotes);
            let subjectPronoun = /\b(he|she)\b/i.test(noQuotes);          // not "his 1994 album" or "after his brother..."
            if (pronoun && (!titleCat || peopleCat || (subjectPronoun && !thingRef))) { who = true; reason = 'pronoun'; }
            else if (peopleCat) { who = true; reason = 'category'; }
            else reason = demos.length ? 'untyped demonstrative' : 'no demonstrative';
            // Only a proper name gets "Who" on this weaker evidence.
            if (who && !/^(the\s+)?[A-Z]/.test(answer)) { who = false; reason += ' (common-noun answer)'; }

            let last = demos.length ? demos[demos.length - 1] : null;
            if (last) {
                if (last.oneOf) plural = false;                       // "one of these" -> a single thing
                else if (last.det != 'this') plural = true;
                else plural = false;
            } else if (/^(they|these|those)\b/i.test(text)) plural = true;
            else if (/\b(they|them|their)\b/i.test(noQuotes) && looksPlural(answer)) plural = true;
            // "They won the World Series" in a teams/bands category: a group of people.
            if (!who && plural && /^(they|them)\b/i.test(text) && /\b(TEAMS?|FRANCHISES?|CLUBS?|BANDS?|GROUPS?|DUOS?|TRIOS?|SPORTS?|BASEBALL|FOOTBALL|BASKETBALL|HOCKEY|SOCCER|NFL|NBA|MLB|NHL|ROCK|POP|MUSIC)\b/i.test(cat) && /^(the\s+)?[A-Z]/.test(answer)) { who = true; reason = 'they + team/band category'; }
        }

        // Names don't take "a"/"an".
        if (who && /^(a|an)\s/i.test(answer)) { who = false; reason += ' (article)'; }
        // A plural-looking answer with plural wording is plural even after "this".
        if (!plural && looksPlural(answer) && /\b(these|those|they)\b/i.test(noQuotes)) plural = true;

        return { who: who, plural: plural, phrase: (who ? 'Who' : 'What') + ' ' + (plural ? 'are' : 'is'), reason: reason };
    }

    function phrase(clue) { return analyze(clue).phrase; }

    return { analyze: analyze, phrase: phrase, isPersonWord: isPersonWord, looksPlural: looksPlural };
})();
