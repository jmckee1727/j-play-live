// judge.js -- decides whether what you said (or typed) matches the archive's
// correct response. Deliberately lenient in the way the show is lenient:
// "what is" is optional, articles are ignored, parenthetical parts of the
// archive answer are optional, a surname alone is accepted for a person,
// and small misspellings / mis-hearings are forgiven.

var JPJudge = (function() {
    'use strict';

    const SMALL_NUMBERS = {
        zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
        eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
        eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
        eighty: 80, ninety: 90,
    };

    function stripHtml(s) {
        if (!s) return '';
        let t = String(s).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ');
        let tmp = document.createElement('textarea');
        tmp.innerHTML = t;
        return tmp.value;
    }

    function normalize(s) {
        s = stripHtml(s).toLowerCase();
        try { s = s.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (e) { }
        s = s.replace(/&/g, ' and ')
             .replace(/[’‘`]/g, "'")
             .replace(/\bst\.\s/g, 'saint ')
             .replace(/\bmt\.\s/g, 'mount ')
             .replace(/\bdr\.\s/g, 'doctor ');
        // Drop the question stem, if any.
        s = s.replace(/^\s*(what|who|where|when|which|whom)\s*(is|are|was|were|s|'s|re|'re|be)?\b\s*/, '');
        s = s.replace(/^\s*(whats|whos|wheres|whens)\b\s*/, '');
        // Punctuation -> space (keep letters, digits, spaces).
        s = s.replace(/[^a-z0-9\s]/g, ' ');
        // Articles anywhere.
        s = s.replace(/\b(a|an|the)\b/g, ' ');
        // Spelled-out small numbers -> digits (helps speech recognition output).
        s = s.replace(/\b([a-z]+)\b/g, function(w) { return (w in SMALL_NUMBERS) ? String(SMALL_NUMBERS[w]) : w; });
        return s.replace(/\s+/g, ' ').trim();
    }

    // All acceptable phrasings of an archive answer, normalized.
    // "(Sir) Isaac Newton"       -> "isaac newton", "sir isaac newton", "newton"
    // "Thomas (Tom) Hanks"       -> "thomas hanks", "thomas tom hanks", "hanks"
    // "a Bloody Mary"            -> "bloody mary", "mary"
    // "Cheryl Strayed or Wild"   -> "cheryl strayed", "wild"
    function variants(correctHtml) {
        let raw = stripHtml(correctHtml).trim();
        let out = new Set();
        let add = function(s) { let n = normalize(s); if (n) out.add(n); };

        let bases = [ raw ];
        // Alternatives joined with "or" or a slash.
        if (/\s+or\s+/i.test(raw))
            bases = bases.concat(raw.split(/\s+or\s+/i));
        if (/\//.test(raw))
            bases = bases.concat(raw.split(/\s*\/\s*/));

        for (let b of bases) {
            let noParens = b.replace(/\([^)]*\)/g, ' ');
            let withParens = b.replace(/[()]/g, ' ');
            add(noParens);
            add(withParens);
            // Parenthetical alone may itself be the accepted answer: "Sir (Elton) John"
            let m, re = /\(([^)]+)\)/g;
            while ((m = re.exec(b)) !== null) {
                let inner = m[1];
                if (!/^(or|aka|also|accept)/i.test(inner) && inner.split(/\s+/).length <= 4)
                    add(b.replace(m[0], ' ').replace(/\S+\s*$/, '') + ' ' + inner); // crude, adds a few harmless extras
                if (/^(or|aka|also accept(ed)?|accept)\s+/i.test(inner))
                    add(inner.replace(/^(or|aka|also accept(ed)?|accept)\s+/i, ''));
            }
            // Surname / last word for multi-word answers.
            let nz = normalize(noParens);
            let toks = nz.split(' ');
            if (toks.length >= 2) {
                let last = toks[toks.length - 1];
                if (last.length >= 4 && !/^\d+$/.test(last))
                    out.add(last);
            }
        }
        return Array.from(out);
    }

    function levenshtein(a, b) {
        if (a == b) return 0;
        if (!a.length) return b.length;
        if (!b.length) return a.length;
        let prev = new Array(b.length + 1), cur = new Array(b.length + 1);
        for (let j = 0; j <= b.length; j++) prev[j] = j;
        for (let i = 1; i <= a.length; i++) {
            cur[0] = i;
            for (let j = 1; j <= b.length; j++) {
                let cost = a[i - 1] == b[j - 1] ? 0 : 1;
                cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
            }
            let t = prev; prev = cur; cur = t;
        }
        return prev[b.length];
    }

    function similarity(a, b) {
        let n = Math.max(a.length, b.length);
        if (!n) return 1;
        return 1 - levenshtein(a, b) / n;
    }

    function wholeWordContains(hay, needle) {
        return (' ' + hay + ' ').indexOf(' ' + needle + ' ') >= 0;
    }

    // Judge one user answer. Returns { correct: bool, reason: string, normalized: string }.
    function judge(userText, correctHtml) {
        let u = normalize(userText || '');
        if (!u)
            return { correct: false, reason: 'no answer', normalized: u };
        let vs = variants(correctHtml);
        let uCompact = u.replace(/\s+/g, '');

        for (let v of vs) {
            if (u == v) return { correct: true, reason: 'exact', normalized: u, matched: v };
            if (uCompact == v.replace(/\s+/g, '')) return { correct: true, reason: 'spacing', normalized: u, matched: v };
        }
        for (let v of vs) {
            // User said the answer plus extra words ("isaac newton the physicist").
            if (v.length >= 4 && wholeWordContains(u, v))
                return { correct: true, reason: 'contains', normalized: u, matched: v };
        }
        for (let v of vs) {
            // Fuzzy: forgive typos / mis-hearings on answers of a reasonable length.
            let sim = similarity(u, v);
            let threshold = v.length <= 4 ? 1.0 : v.length <= 7 ? 0.75 : 0.8;
            if (sim >= threshold)
                return { correct: true, reason: 'fuzzy ' + sim.toFixed(2), normalized: u, matched: v };
            // Compact comparison (speech recognition sometimes glues or splits words).
            let simC = similarity(uCompact, v.replace(/\s+/g, ''));
            if (v.length > 7 && simC >= 0.85)
                return { correct: true, reason: 'fuzzy-compact ' + simC.toFixed(2), normalized: u, matched: v };
        }
        for (let v of vs) {
            // User gave a large, distinctive piece of a long answer ("gentlemen of verona").
            if (u.length >= 6 && v.length >= 10 && wholeWordContains(v, u) && u.length / v.length >= 0.5)
                return { correct: true, reason: 'partial', normalized: u, matched: v };
        }
        for (let v of vs) {
            // Sounds the same: a spoken response that a recognizer wrote down with a
            // different spelling ("series" for Ceres, "holding car field" for Holden
            // Caulfield). Spellings that sound alike are folded together, then compared.
            let a = soundFold(u), b = soundFold(v);
            if (a.length >= 2 && a == b)
                return { correct: true, reason: 'sounds like', normalized: u, matched: v };
            if (a.length >= 4 && b.length >= 4) {
                let sim = similarity(a, b);
                if ((b.length >= 5 && sim >= 0.8) || (b.length >= 10 && sim >= 0.75))
                    return { correct: true, reason: 'sounds like ' + sim.toFixed(2), normalized: u, matched: v };
            }
        }
        return { correct: false, reason: 'no match', normalized: u, variants: vs };
    }

    // Homophones the spelling rules below can't fold (irregular spellings and
    // names a recognizer writes its own way). Each group is one sound; a word
    // from a group stands in for all of them.
    const HOMOPHONE_GROUPS = [
        'to too two', 'one won', 'eye i aye', 'know no', 'knows nose noes', 'hour our', 'whole hole', 'ate eight', 'four for fore',
        'sun son', 'buy by bye', 'there their theyre', 'wood would', 'red read', 'lead led', 'hear here', 'heard herd', 'higher hire',
        'him hymn', 'in inn', 'knew new gnu', 'knot not naught', 'oar or ore', 'some sum', 'threw through', 'which witch', 'wear where ware',
        'weather whether', 'write right rite wright', 'be bee', 'sea see', 'so sew sow', 'sole soul seoul', 'role roll', 'root route',
        'none nun', 'made maid', 'mail male', 'meat meet mete', 'pair pear pare', 'peace piece', 'peak peek pique', 'principal principle',
        'rap wrap', 'stair stare', 'stake steak', 'suite sweet', 'tide tied', 'toe tow', 'vain vein vane', 'waist waste', 'way weigh whey',
        'week weak', 'flour flower', 'aloud allowed', 'bear bare', 'board bored', 'brake break', 'cell sell', 'cent scent sent',
        'cereal serial', 'coarse course', 'dear deer', 'die dye', 'fair fare', 'feat feet', 'flea flee', 'grate great', 'hair hare', 'heal heel',
        'idle idol', 'pail pale', 'plain plane', 'rain reign rein', 'sail sale', 'steal steel', 'tail tale', 'wait weight', 'blue blew',
        'bread bred', 'cents sense scents', 'cheap cheep', 'chord cord', 'cite sight site', 'creak creek', 'days daze', 'dew due do doe dough',
        'doe dough do', 'ewe you yew u', 'faint feint', 'find fined', 'fir fur', 'flew flu flue', 'gait gate', 'genes jeans', 'guest guessed',
        'hall haul', 'hay hey', 'heroin heroine', 'hoarse horse', 'holy wholly', 'knight night', 'lesson lessen', 'liar lyre', 'lo low',
        'loan lone', 'mantel mantle', 'marshal martial', 'miner minor', 'mist missed', 'morning mourning', 'muscle mussel', 'naval navel',
        'oh o owe', 'ode owed', 'pain pane', 'passed past', 'patience patients', 'pause paws pours pores', 'pedal peddle petal', 'peer pier',
        'plum plumb', 'pole poll', 'pray prey', 'prince prints', 'profit prophet', 'rack wrack', 'raise rays raze', 'real reel', 'rest wrest',
        'ring wring', 'rose rows roes', 'rye wry', 'scene seen', 'seam seem', 'seas sees seize', 'shear sheer', 'shoe shoo', 'side sighed',
        'slay sleigh', 'soar sore', 'sold soled', 'sole soul', 'sort sought', 'stationary stationery', 'straight strait', 'sundae sunday',
        'tacks tax', 'team teem', 'tense tents', 'thrown throne', 'tire tyre', 'told tolled', 'troop troupe', 'vial vile', 'vice vise',
        'wade weighed', 'wail whale wale', 'war wore', 'warn worn', 'ways weighs', 'weve weave', 'whine wine', 'wrung rung', 'yoke yolk', 'yore your youre',
        'ad add', 'air heir ere', 'aisle isle ill', 'altar alter', 'ant aunt', 'arc ark', 'ball bawl', 'band banned', 'bald bawled', 'base bass',
        'beach beech', 'bean been', 'beat beet', 'berry bury', 'berth birth', 'billed build', 'blew blue', 'bloc block', 'boar bore', 'bolder boulder',
        'born borne', 'bough bow', 'boy buoy', 'bridal bridle', 'but butt', 'cache cash', 'canvas canvass', 'capital capitol', 'carat carrot karat caret',
        'cast caste', 'ceiling sealing', 'cellar seller', 'censor sensor', 'cereal serial', 'chews choose', 'choral coral', 'chute shoot', 'clause claws',
        'climb clime', 'close clothes', 'colonel kernel', 'complement compliment', 'council counsel', 'currant current', 'cymbal symbol', 'dam damn',
        'desert dessert', 'discreet discrete', 'dual duel', 'earn urn', 'elicit illicit', 'fairy ferry', 'faze phase', 'feudal futile', 'flair flare',
        'foul fowl', 'franc frank', 'frees freeze frieze', 'gild guild', 'gilt guilt', 'gorilla guerrilla', 'grease greece', 'groan grown', 'hangar hanger',
        'heard herd', 'hew hue', 'hi high', 'hoard horde', 'idle idol idyll', 'incite insight', 'jam jamb', 'key quay', 'lacks lax', 'lain lane',
        'leach leech', 'leak leek', 'lean lien', 'lessen lesson', 'levee levy', 'links lynx', 'load lode', 'locks lox', 'loot lute', 'main maine mane',
        'manner manor', 'mall maul', 'marry mary merry', 'medal meddle', 'metal mettle', 'mind mined', 'moose mousse', 'mown moan', 'nay neigh',
        'nice niece', 'oral aural', 'overdo overdue', 'paced paste', 'packed pact', 'palate palette pallet', 'peal peel', 'pearl purl', 'pi pie',
        'plait plate', 'pleas please', 'pore pour poor', 'praise prays preys', 'presence presents', 'rains reins reigns', 'rapt wrapped',
        'reek wreak', 'review revue', 'rhyme rime', 'right rite write', 'roam rome', 'rode road rowed', 'rote wrote', 'sac sack', 'sane seine',
        'saver savor', 'sects sex', 'serf surf', 'sew so sow', 'shake sheikh sheik', 'sic sick', 'slew slough', 'sleight slight', 'soared sword',
        'staid stayed', 'stalk stork', 'steppe step', 'stile style', 'tacked tact', 'tea tee', 'tern turn', 'tic tick', 'tied tide', 'tracked tract',
        'vale veil', 'wails wales whales', 'waive wave', 'weal wheel', 'wet whet', 'whirled world', 'who hoo', 'whoa woe', 'wreck reck', 'yule youll',
        'chile chili chilly', 'czech check cheque', 'thai tie tye', 'rhodes roads', 'bern burn berne', 'lyon lion', 'nice niece', 'seoul soul sole',
        'sean shawn shaun shon', 'steven stephen', 'jeff geoff', 'jon john', 'eric erik erick', 'kathryn catherine katherine kathrine catharine katharine',
        'bryan brian brien', 'sara sarah', 'hanukkah chanukah hanukah hannukah', 'gandhi ghandi', 'mohammed muhammad mohammad mohamed muhammed',
        'tchaikovsky chaikovsky', 'gene jean', 'carl karl', 'kristen christen kristin', 'allen alan allan', 'ann anne', 'marc mark', 'philip phillip',
        'jeffrey geoffrey', 'zach zack zak', 'kurt curt', 'greg gregg', 'nicolas nicholas', 'chris kris', 'christina kristina', 'tracy tracey',
        'stacy stacey', 'jamie jaime', 'kaitlyn caitlin katelyn caitlyn', 'madeline madeleine', 'michaela mikayla', 'lindsay lindsey', 'kelly kelley',
        'shelley shelly', 'terry terri', 'lee leigh li', 'gail gayle', 'isaac isaak', 'aaron erin', 'barry berry', 'carrie kerry carey cary',
        'brittany britney brittney', 'jesse jessie', 'teresa theresa', 'elliot elliott eliot', 'matthew mathew', 'luis louis lewis', 'rachel rachael',
        'kristen kristin', 'hailey haley hayley', 'ashley ashleigh', 'megan meghan meagan', 'niall nile', 'sofia sophia', 'alyssa alissa', 'jaden jayden',
        'cain kane', 'abel able', 'dane deign', 'grey gray', 'mike mic', 'shaw shah', 'thor thaw',
        'tough tuff', 'rough ruff', 'enough enuff', 'cough coff', 'trough troff', 'though tho', 'thorough thurrow', 'drought drout',
    ];
    const HOMOPHONE = { };
    for (let g of HOMOPHONE_GROUPS) { let ws = g.split(' '); for (let w of ws) if (!(w in HOMOPHONE)) HOMOPHONE[w] = ws[0]; }

    // Sound folding: spellings that sound alike become one spelling, the words
    // run together, so a recognizer's homophone lands on (or close to) the real
    // answer: "low" for lo, "series" for Ceres, "Shawn" for Sean. Each word is
    // first swapped for its homophone group's name.
    function soundFold(text) {
        let words = String(text).toLowerCase().replace(/[^a-z' ]/g, ' ').replace(/'/g, '').split(/\s+/).filter(Boolean);
        words = words.map(function(w) { return HOMOPHONE[w] || w; });
        let t = ' ' + words.join(' ') + ' ';
        // Consonants: silent letters, then the spellings of one sound.
        t = t.replace(/ wr/g, ' r').replace(/ kn/g, ' n').replace(/ gn/g, ' n').replace(/ ps/g, ' s').replace(/ pn/g, ' n').replace(/ rh/g, ' r').replace(/ gh/g, ' g').replace(/ wh/g, ' w')
             .replace(/mb /g, 'm ').replace(/mn /g, 'm ').replace(/gn /g, 'n ').replace(/augh /g, 'af ').replace(/ght/g, 't').replace(/gh /g, ' ').replace(/gh(?=[^aeiou ])/g, '')
             .replace(/ph/g, 'f').replace(/dh/g, 'd').replace(/bh/g, 'b').replace(/kh/g, 'k').replace(/([aeiou])h(?=[^aeiouy]|$| )/g, '$1')
             .replace(/sch/g, 'sk').replace(/tch/g, 'ch').replace(/sh/g, 'x').replace(/ch/g, 'x').replace(/th/g, 't').replace(/wh/g, 'w')
             .replace(/sc(?=[eiy])/g, 's').replace(/c(?=[eiy])/g, 's').replace(/ck/g, 'k').replace(/c/g, 'k').replace(/qu/g, 'kw').replace(/q/g, 'k').replace(/x/g, 'ks')
             .replace(/z/g, 's').replace(/dg/g, 'j').replace(/g(?=[eiy])/g, 'j');
        // Vowels: the common spellings of one sound.
        t = t.replace(/ie(?= )/g, 'i').replace(/ye(?= )/g, 'i').replace(/y/g, 'i')
             .replace(/ea/g, 'e').replace(/ee/g, 'e').replace(/ie/g, 'e').replace(/ei/g, 'a').replace(/ey(?= )/g, 'e')
             .replace(/oo/g, 'u').replace(/ou/g, 'u').replace(/ue/g, 'u').replace(/ew/g, 'u')
             .replace(/au/g, 'o').replace(/aw/g, 'o').replace(/oa/g, 'o').replace(/oe(?= )/g, 'o').replace(/ow(?= |n)/g, 'o')
             .replace(/ai/g, 'a')
             .replace(/([a-z]{2,})e(?= )/g, '$1');                        // a silent final e
        t = t.replace(/(.)\1+/g, '$1').replace(/\s+/g, '');
        return t;
    }

    // Judge several candidate transcriptions (speech recognition alternatives).
    function judgeAny(candidates, correctHtml) {
        let first = null;
        for (let c of candidates || [ ]) {
            let r = judge(c, correctHtml);
            r.text = c;
            if (!first) first = r;
            if (r.correct) return r;
        }
        return first || { correct: false, reason: 'no answer', normalized: '', text: '' };
    }

    // "What is..." and nothing more: a question stem, fillers, or silence. Not a
    // response yet -- the player is still thinking, so the window stays open.
    const STEM_RE = /^(?:(?:what|who|where|when|which|how|why)(?:s|re)?(?:\s+(?:is|are|was|were|it|its))*\s*)+/;
    const FILLER = /^(?:is|are|was|were|it|its|the|a|an|um+|uh+|uhm+|er+|erm+|hm+|hmm+|mm+|ah+|oh+|ooh+|like|well|so|okay|ok|yeah|yes|no|let|lets|see|me|think|i|ill|say|go|with|maybe|probably|that|thats|this|wait|hold|on|and|or|but)$/;
    // A recognizer's word for a noise ("explosion", "[silence]") with no question stem is nothing said either.
    const NOISE = /^(silence|silent|explosion|boom|bang|noise|click|clicks|static|music|laughter|laughs|applause|thump|cough|coughs|sigh|sighs|beep|beeps|buzz|buzzing|rustling|breathing|thud|crash|ding|blank audio|inaudible|unintelligible)$/;
    function contentFree(text) {
        let raw = String(text || '').replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, ' ');
        let t = raw.toLowerCase().replace(/[^a-z0-9'\s]/g, ' ').replace(/'/g, '').replace(/\s+/g, ' ').trim();
        if (NOISE.test(t)) return true;
        t = t.replace(STEM_RE, '');
        return t.split(' ').filter(Boolean).every(function(w) { return FILLER.test(w); });
    }

    return { normalize: normalize, variants: variants, judge: judge, judgeAny: judgeAny, similarity: similarity, stripHtml: stripHtml, contentFree: contentFree, soundFold: soundFold };
})();
