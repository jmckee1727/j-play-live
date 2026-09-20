// reader.js -- turns J! Archive text into text a speech engine reads well.
//
// Jeopardy! clues are written for the screen, not for a voice: they lean on
// abbreviations ("cont. U.S.", "pres.", "St."), Roman numerals ("Henry VIII",
// "WWII"), decades ("the '60s"), double dashes, ALL-CAPS category names and
// bracketed asides. JPReader normalizes those so the built-in voice sounds
// like it understands what it is reading.

var JPReader = (function() {
    'use strict';

    function decode(html) {
        let s = String(html || '')
            .replace(/<br\s*\/?>/gi, ', ')
            .replace(/<\/(p|div|li)>/gi, ', ')
            .replace(/<[^>]+>/g, ' ');
        let tmp = document.createElement('textarea');
        tmp.innerHTML = s;
        return tmp.value;
    }

    const ORDINALS = [ '', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth', 'twentieth', 'twenty-first', 'twenty-second', 'twenty-third', 'twenty-fourth', 'twenty-fifth', 'twenty-sixth', 'twenty-seventh', 'twenty-eighth', 'twenty-ninth', 'thirtieth' ];
    const CARDINALS = [ '', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty', 'twenty-one', 'twenty-two', 'twenty-three', 'twenty-four', 'twenty-five', 'twenty-six', 'twenty-seven', 'twenty-eight', 'twenty-nine', 'thirty' ];
    const ROMAN = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
    function romanToInt(r) {
        let n = 0;
        for (let i = 0; i < r.length; i++) {
            let v = ROMAN[r[i]], nx = ROMAN[r[i + 1]] || 0;
            n += v < nx ? -v : v;
        }
        return n;
    }
    // Words that take a cardinal after a numeral ("World War II" -> "World War two").
    const CARDINAL_BEFORE = /(World War|War|Super Bowl|Bowl|Rocky|Part|Chapter|Act|Book|Volume|Vol\.|Episode|Phase|Apollo|Gemini|Skylab|Mercury|Saturn|Titan|Star Wars|Final Fantasy|Xbox|Playstation|Toy Story|Shrek|Jaws|Terminator|Godfather|Alien|Predator|Rambo|Mad Max|Iron Man|Kill Bill|Scream|Halloween|Friday the 13th|Ocean's|Mission: Impossible|Class|Type|Level|Stage|Grade|Tier|Round|Article|Section|Title|Amendment|Article|Formula|Generation|Version|Mark|Mk\.)\s$/i;

    const DECADES = { '00': 'aughts', '10': 'tens', '20': 'twenties', '30': 'thirties', '40': 'forties', '50': 'fifties', '60': 'sixties', '70': 'seventies', '80': 'eighties', '90': 'nineties' };

    const ABBREVIATIONS = [
        [ /\bMt\.\s+(?=[A-Z])/g, 'Mount ' ],
        [ /\bMts\.\s+/g, 'Mountains ' ],
        [ /\bSt\.\s+(?=[A-Z])/g, 'Saint ' ],
        [ /\bSte\.\s+(?=[A-Z])/g, 'Sainte ' ],
        [ /\bFt\.\s+(?=[A-Z])/g, 'Fort ' ],
        [ /\bPt\.\s+(?=[A-Z])/g, 'Point ' ],
        [ /\bDr\.\s+(?=[A-Z])/g, 'Doctor ' ],
        [ /\bProf\.\s+(?=[A-Z])/g, 'Professor ' ],
        [ /\bRev\.\s+(?=[A-Z])/g, 'Reverend ' ],
        [ /\bFr\.\s+(?=[A-Z])/g, 'Father ' ],
        [ /\bGen\.\s+(?=[A-Z])/g, 'General ' ],
        [ /\bAdm\.\s+(?=[A-Z])/g, 'Admiral ' ],
        [ /\bCol\.\s+(?=[A-Z])/g, 'Colonel ' ],
        [ /\bMaj\.\s+(?=[A-Z])/g, 'Major ' ],
        [ /\bCapt\.\s+(?=[A-Z])/g, 'Captain ' ],
        [ /\bCpt\.\s+(?=[A-Z])/g, 'Captain ' ],
        [ /\bLt\.\s+(?=[A-Z])/g, 'Lieutenant ' ],
        [ /\bSgt\.\s+(?=[A-Z])/g, 'Sergeant ' ],
        [ /\bCpl\.\s+(?=[A-Z])/g, 'Corporal ' ],
        [ /\bPvt\.\s+(?=[A-Z])/g, 'Private ' ],
        [ /\bCmdr\.\s+(?=[A-Z])/g, 'Commander ' ],
        [ /\bPres\.\s+(?=[A-Z])/g, 'President ' ],
        [ /\bpres\.\s+/g, 'presidential ' ],
        [ /\bVP\b/g, 'V.P.' ],
        [ /\bGov\.\s+(?=[A-Z])/g, 'Governor ' ],
        [ /\bSen\.\s+(?=[A-Z])/g, 'Senator ' ],
        [ /\bRep\.\s+(?=[A-Z])/g, 'Representative ' ],
        [ /\bSec\.\s+(?=[A-Z])/g, 'Secretary ' ],
        [ /\bAmb\.\s+(?=[A-Z])/g, 'Ambassador ' ],
        [ /\bAtty\.\s+/g, 'Attorney ' ],
        [ /\bBros\.\s*/g, 'Brothers ' ],
        [ /\bJr\.?(?=[\s,.)]|$)/g, 'Junior' ],
        [ /\bSr\.?(?=[\s,.)]|$)/g, 'Senior' ],
        [ /\bvs\.?\s+/gi, 'versus ' ],
        [ /\bv\.\s+(?=[A-Z])/g, 'versus ' ],
        [ /\bNo\.\s*(?=\d)/g, 'number ' ],
        [ /\bNos\.\s*(?=\d)/g, 'numbers ' ],
        [ /\bft\.(?=[\s,.)]|$)/g, 'feet' ],
        [ /\bsq\.\s+/g, 'square ' ],
        [ /\bmi\.(?=[\s,.)]|$)/g, 'miles' ],
        [ /\bmph\b/g, 'miles per hour' ],
        [ /\blbs?\.(?=[\s,.)]|$)/g, 'pounds' ],
        [ /\boz\.(?=[\s,.)]|$)/g, 'ounces' ],
        [ /\bkm\b/g, 'kilometers' ],
        [ /\bhrs?\.(?=[\s,.)]|$)/g, 'hours' ],
        [ /\bmin\.(?=[\s,.)]|$)/g, 'minutes' ],
        [ /\bapprox\.\s*/g, 'approximately ' ],
        [ /\be\.g\.,?\s*/g, 'for example, ' ],
        [ /\bi\.e\.,?\s*/g, 'that is, ' ],
        [ /\betc\.(?=[\s,.)]|$)/g, 'et cetera' ],
        [ /\bc\.\s*(?=\d{3,4})/g, 'circa ' ],
        [ /\bca\.\s*(?=\d{3,4})/g, 'circa ' ],
        [ /\bb\.\s*(?=\d{3,4})/g, 'born ' ],
        [ /\bd\.\s*(?=\d{3,4})/g, 'died ' ],
        [ /\baka\b/gi, 'also known as' ],
        [ /\ba\.k\.a\./gi, 'also known as' ],
        [ /\bcont\.\s+(?=U\.S\.)/g, 'continental ' ],
        [ /\bcent\.(?=[\s,.)]|$)/g, 'century' ],
        [ /\bcents\.(?=[\s,.)]|$)/g, 'centuries' ],
        [ /\bAve\.(?=[\s,.)]|$)/g, 'Avenue' ],
        [ /\bBlvd\.(?=[\s,.)]|$)/g, 'Boulevard' ],
        [ /\bRd\.(?=[\s,.)]|$)/g, 'Road' ],
        [ /\bSt\.(?=[\s,.)]|$)/g, 'Street' ],
        [ /\bHwy\.?(?=[\s,.)]|$)/g, 'Highway' ],
        [ /\bRte\.?(?=[\s,.)]|$)/g, 'Route' ],
        [ /\bDept\.(?=[\s,.)]|$)/g, 'Department' ],
        [ /\bUniv\.(?=[\s,.)]|$)/g, 'University' ],
        [ /\bInc\.(?=[\s,.)]|$)/g, 'Incorporated' ],
        [ /\bCo\.(?=[\s,.)]|$)/g, 'Company' ],
        [ /\bCorp\.(?=[\s,.)]|$)/g, 'Corporation' ],
        [ /\bLtd\.(?=[\s,.)]|$)/g, 'Limited' ],
        [ /\bJan\.\s+(?=\d)/g, 'January ' ], [ /\bFeb\.\s+(?=\d)/g, 'February ' ], [ /\bMar\.\s+(?=\d)/g, 'March ' ], [ /\bApr\.\s+(?=\d)/g, 'April ' ],
        [ /\bAug\.\s+(?=\d)/g, 'August ' ], [ /\bSept?\.\s+(?=\d)/g, 'September ' ], [ /\bOct\.\s+(?=\d)/g, 'October ' ], [ /\bNov\.\s+(?=\d)/g, 'November ' ], [ /\bDec\.\s+(?=\d)/g, 'December ' ],
        [ /\bWWII\b/g, 'World War two' ],
        [ /\bWWI\b/g, 'World War one' ],
        [ /\bW\.W\.\s?II\b/g, 'World War two' ],
        [ /\bW\.W\.\s?I\b/g, 'World War one' ],
        [ /\b(\d+)\s?%/g, '$1 percent' ],
        [ /\b(\d+)-(\d+)\b/g, '$1 to $2' ],          // ranges: 1861-65, 1914-1918
        [ /(\d)\s?°\s?F\b/g, '$1 degrees Fahrenheit' ],
        [ /(\d)\s?°\s?C\b/g, '$1 degrees Celsius' ],
        [ /(\d)\s?°/g, '$1 degrees' ],
        [ /\bMr\.\s/g, 'Mister ' ],
        [ /\bMrs\.\s/g, 'Missus ' ],
        [ /\bMs\.\s/g, 'Miz ' ],
    ];

    // Names and titles that take a numeral "I" (the pronoun "I" never does).
    const TAKES_FIRST = /^(Part|Chapter|Act|Book|Volume|Episode|Phase|Class|Type|Level|Stage|Round|Article|Section|Title|Amendment|Formula|Generation|Version|Mark|Pope|King|Queen|Emperor|Empress|Czar|Tsar|Kaiser|Napoleon|Ptolemy|Louis|Henry|Charles|George|Edward|James|William|Richard|Elizabeth|Mary|Peter|Nicholas|Alexander|Frederick|Philip|Ferdinand|Leo|Pius|Paul|John|Ivan|Catherine|Constantine|Justinian|Selim|Murad|Mehmed|Suleiman|Darius|Xerxes|Cyrus|Ramses|Rameses|Thutmose|Amenhotep|Rocky|Jaws|Shrek|Scream|Alien|Rambo|Terminator|Godfather|Halloween|Umberto|Wilhelm|Otto|Carlos|Juan|Alfonso|Pedro|Manuel|Olaf|Harald|Haakon|Magnus|Gustav|Karl|Carl|Frederik|Christian|Casimir|Boleslaw|Vladimir|Yaroslav|Stephen|Ladislaus|Sigismund|Wenceslaus|Rudolf|Leopold|Francis|Franz|Joseph|Maximilian|Albert|Baudouin|Leopold|Willem|Juliana|Beatrix|Margrethe|Victor|Emmanuel|Humbert|Vittorio|Amadeus|Sixtus|Gregory|Clement|Innocent|Urban|Benedict|Boniface|Celestine|Martin|Sergius|Adrian|Hadrian|Honorius|Lucius|Julius|Callixtus|Eugene|Felix|Anastasius|Pelagius|Zachary|Damasus|Sylvester|Agapetus|Marinus|Romanus|Valentine|Conon|Lando|Formosus|Theodore|Zeno|Basil|Michael|Theodosius|Valentinian|Diocletian|Maximian|Gordian|Antiochus|Seleucus|Mithridates|Attalus|Eumenes|Cleopatra|Arsinoe|Berenice|Agrippa|Herod|Abbas|Ismail|Tahmasp|Nader|Fath-Ali|Reza|Faisal|Abdullah|Hussein|Hassan|Mohammed|Mohammad|Muhammad|Ahmad|Ahmed|Mahmud|Bayezid|Osman|Orhan|Ibrahim|Mustafa|Abdul|Abdulhamid|Mehmet|Rama|Chulalongkorn|Bhumibol|Vajiralongkorn|Norodom|Sihanouk|Akihito|Naruhito|Hirohito|Meiji|Taisho|Showa|Heisei|Reiwa|Kangxi|Qianlong|Yongle|Hongwu|Wanli|Zhengde|Jiajing|Chongzhen|Shunzhi|Yongzheng|Jiaqing|Daoguang|Xianfeng|Tongzhi|Guangxu|Xuantong|Puyi)$/i;

    // "Henry VIII" -> "Henry the eighth"; "World War II" -> "World War two";
    // "Super Bowl XLII" -> "Super Bowl forty-two". "Malcolm X", "Vitamin C"
    // and the pronoun "I" are left alone.
    function fixRomanNumerals(s) {
        return s.replace(/\b([A-Za-z][A-Za-z'.-]*)\s+(XXX|XX|XIX|XVIII|XVII|XVI|XV|XIV|XIII|XII|XI|X|IX|VIII|VII|VI|V|IV|III|II|I|XL|L|XLII|XLIII|XLIV|XLV|XLVI|XLVII|XLVIII|XLIX|LI|LII|LIII|LIV|LV|LVI|LVII|LVIII|LIX)\b(?![.\w-])/g, function(all, word, roman) {
            if (roman == 'I' && !TAKES_FIRST.test(word)) return all;
            if (roman == 'X' || roman == 'L') return all;                       // Malcolm X, Generation X
            if (!/^[A-Z]/.test(word) && !CARDINAL_BEFORE.test(word + ' ')) return all;
            if (word.length > 1 && word == word.toUpperCase() && !/^(WORLD|WAR|SUPER|BOWL|POPE|KING|QUEEN|PART|ACT|ROCKY|JAWS|HENRY|LOUIS|GEORGE|EDWARD|JAMES|WILLIAM|RICHARD|ELIZABETH|CHARLES)$/.test(word)) return all; // MTV X etc.
            let n = romanToInt(roman);
            if (!n || n > 60) return all;
            let cardinal = n <= 30 ? CARDINALS[n] : String(n);
            let ordinal = n <= 30 ? ORDINALS[n] : String(n) + (n % 10 == 1 && n != 11 ? 'st' : n % 10 == 2 && n != 12 ? 'nd' : n % 10 == 3 && n != 13 ? 'rd' : 'th');
            if (CARDINAL_BEFORE.test(word + ' ')) return word + ' ' + cardinal;
            return word + ' the ' + ordinal;
        });
    }

    function fixDecades(s) {
        return s.replace(/'(\d0)s\b/g, function(all, d) { return DECADES[d] || all; })
                .replace(/\b(1[6-9]|20)(\d0)s\b/g, function(all, c, d) {
                    let cent = { '16': 'sixteen', '17': 'seventeen', '18': 'eighteen', '19': 'nineteen', '20': 'twenty' }[c];
                    return d == '00' ? (c == '20' ? 'two thousands' : cent + ' hundreds') : cent + ' ' + DECADES[d];
                });
    }

    // Plain speech text for a clue.
    function clueToSpeech(html) {
        let s = decode(html);
        s = s.replace(/\[\*\*?\]/g, '')
             .replace(/\[[^\]]*\]/g, ' ')                                // [Laughter], [The end-of-round signal sounds]
             .replace(/_{2,}/g, ' blank ')
             .replace(/\s*&\s*/g, ' and ')
             .replace(/\s*(--|—|–)\s*/g, ', ')
             .replace(/\.\.\./g, ', ')
             .replace(/([A-Za-z]*[a-z][A-Za-z]*)\s*\/\s*(?=[A-Za-z]*[a-z])/g, '$1 or ')   // "Fitzgerald/Hemingway" (not 9/11, 1/2, AC/DC)
             .replace(/(\d),(\d{3})/g, '$1$2');                           // 1,200 -> 1200 (voices read it as a number either way)
        for (let a of ABBREVIATIONS) s = s.replace(a[0], a[1]);
        s = fixRomanNumerals(s);
        s = fixDecades(s);
        s = s.replace(/\bU\.S\.(?=[\s,.)]|$)/g, 'U.S.')
             .replace(/\s+/g, ' ')
             .replace(/\s+([,.;:!?])/g, '$1')
             .replace(/,\s*,/g, ',')
             .replace(/\(\s*\)/g, '')
             .replace(/^[,\s]+|[,\s]+$/g, '')
             .trim();
        return s;
    }

    // All-caps tokens that stay as letters when a category is title-cased.
    // J! Archive writes every category in capitals, so capitals alone are no
    // signal: only unambiguous initialisms belong here. Anything that is also
    // an ordinary word (IT, US, AM, AD, PET, MAC, PIN, LED, POW, RIP, MIA, SIM,
    // LA, HI, MA, PA...) is left out and read as the word; the archive writes
    // the abbreviations with periods (U.S., A.M., L.A.) when it means them.
    const KEEP_CAPS = /^(TV|U\.S\.A?\.?|USA|U\.K\.|U\.N\.|A\.M\.|P\.M\.|B\.C\.|A\.D\.|L\.A\.|D\.C\.|NFL|NBA|MLB|NHL|MLS|NCAA|NASCAR|PGA|LPGA|UFC|WWE|NASA|NATO|UNESCO|FBI|CIA|NSA|IRS|DEA|ATF|EPA|FDA|CDC|NIH|FCC|FTC|SEC|USDA|DMV|USPS|UPS|FedEx|GOP|DNC|RNC|USSR|CCCP|EU|UAE|UK|NYC|DC|SF|LAX|JFK|MVP|CEO|CFO|CTO|COO|VIP|DNA|RNA|HIV|COVID|SARS|MRI|CT|ER|ICU|EMT|CPR|HBO|ESPN|NPR|PBS|BBC|CNN|ABC|NBC|CBS|MTV|VH1|AMC|TNT|TBS|CW|FX|MSNBC|CNBC|OPEC|OSHA|NAFTA|NORAD|ACLU|NAACP|SNL|PC|USB|GPS|GDP|IQ|PhD|MBA|MD|JD|RN|CPA|FAQ|ETA|RSVP|ASAP|DIY|BYOB|AWOL|BC|BCE|CE|ATM|LCD|HD|4K|3D|2D|AI|VR|AR|HR|PR|DJ|MC|EP|LP|CD|DVD|VHS|VCR|FM|UFO|UFOs|IOU|IOUs|ID|IDs|A&E|Q&A|R&B|B&B|S&P|AT&T|H&M|M&M|M&Ms|J\.?K\.?|E\.T\.|R2-D2|C-3PO|BB-8|ABBA|NSYNC|AC\/DC|REM|R\.E\.M\.|U2|OMD|UB40|INXS|TLC|CCR|ELO|ZZ|MGM|RKO|ILM|IBM|HP|AMD|GE|GM|3M|BMW|VW|KFC|IHOP|TGIF|A&W|CVS|DHL|IKEA|XXX|XL|XXL|II|III|IV|VI|VII|VIII|IX|XI|XII|XIII|XIV|XV|XVI|XVII|XVIII|XIX|XX)$/;
    const SMALL_WORDS = /^(a|an|the|of|in|on|at|to|by|for|and|or|but|nor|as|vs|with|from|into|onto|over|under|up|down|off|out|per|via|than|so|yet)$/i;

    // "5 "BAD" PLACES TO SEE BEFORE YOU DIE" -> "5 "Bad" Places to See Before You Die"
    function titleCase(s) {
        return String(s).split(/(\s+)/).map(function(tok, i, arr) {
            if (!tok.trim()) return tok;
            let m = /^([("'\[]*)(.*?)([)"',.!?:;\]]*)$/.exec(tok);
            let pre = m[1], core = m[2], post = m[3];
            if (!core) return tok;
            if (/\./.test(core) && post.charAt(0) == '.') { core += '.'; post = post.slice(1); }   // "U.S." keeps its last period
            let poss = /^(.+)('S|'s|’S|’s)$/.exec(core);
            if (poss && KEEP_CAPS.test(poss[1])) return pre + poss[1] + "'s" + post;
            if (KEEP_CAPS.test(core)) return tok;
            if (/\d/.test(core) && !/[a-z]{3,}/i.test(core)) return tok;                 // 1990s, 3-D
            if (/^([A-Z]\.){2,}[A-Za-z]?$/.test(core)) return tok;                        // J.F.K., D.C., A.M.
            let lower = core.toLowerCase();
            if (i > 0 && SMALL_WORDS.test(lower) && !pre) return pre + lower + post;
            // hyphenated and apostrophe words: capitalize each piece
            let cased = lower.replace(/(^|-)([a-z])/g, function(a, sep, ch) { return sep + ch.toUpperCase(); });
            // O'Neill, D'Angelo, L'Oreal keep a capital after the apostrophe; contractions (I'm, I'll, y'all, o'clock) don't.
            if (/^[ODL]['’][a-z]/.test(cased) && !/^o['’]clock/i.test(cased)) cased = cased.replace(/^([ODL])(['’])([a-z])/, function(a, x, ap, y) { return x + ap + y.toUpperCase(); });
            return pre + cased + post;
        }).join('');
    }

    // Category name for the eye: keep as the archive has it. For the voice:
    // title-cased so the engine says words, not letters.
    function categoryToSpeech(name) {
        let s = decode(name).replace(/\s*&\s*/g, ' and ').replace(/_{2,}/g, ' blank ');
        s = titleCase(s);
        for (let a of ABBREVIATIONS) s = s.replace(a[0], a[1]);
        s = fixRomanNumerals(s);
        s = fixDecades(s);
        return s.replace(/\s+/g, ' ').trim();
    }

    // A category's note, e.g. "(Ken: Start each response with the letters "A-R".)"
    function commentToSpeech(comment) {
        let s = decode(comment).trim();
        s = s.replace(/^\(\s*(?:[A-Z][a-z]+(?: [A-Z][a-z]+)?):\s*/, '(')       // drop the "(Ken: " speaker tag
             .replace(/^\(|\)$/g, '')
             .replace(/\[[^\]]*\]/g, ' ');
        return clueToSpeech(s);
    }

    // A response the host or a contestant says aloud.
    function responseToSpeech(text) {
        return clueToSpeech(text).replace(/\bblank\b/g, '');
    }

    // Cadence for the studio (neural) voice. A neural voice takes its
    // phrasing from punctuation, and Jeopardy! clues are written without the
    // sentence-final period, with semicolons doing the work of full stops and
    // colons introducing quotations. So: give every line a terminal stop
    // (clues are statements, never questions), let a semicolon become a full
    // stop with a beat, turn "..." into a longer pause, and keep quoted titles
    // intact (the voice sets them off on its own). kind: 'clue' | 'category'
    // | 'line' (host banter, confirmations, responses).
    function forNeural(text, kind) {
        let s = String(text || '').trim();
        if (!s) return s;
        s = s.replace(/\s*;\s*/g, '. ')                   // clause boundary -> full stop
             .replace(/\s*:\s*(?=")/g, ': ')                // colon before a quote stays
             .replace(/\s*,\s*,+/g, ', ')
             .replace(/\.{3,}/g, ' ... ')
             .replace(/\s+/g, ' ')
             .trim();
        if (kind == 'category') {
            // Read as a title: a short line, said with a period so it lands.
            if (!/[.!?]$/.test(s)) s += '.';
            return s;
        }
        // Clues that end in a quoted word keep the period inside the sentence.
        if (!/[.!?]["')\]]?$/.test(s)) s += '.';
        return s;
    }

    return { clueToSpeech: clueToSpeech, categoryToSpeech: categoryToSpeech, commentToSpeech: commentToSpeech, responseToSpeech: responseToSpeech, forNeural: forNeural, titleCase: titleCase, fixRomanNumerals: fixRomanNumerals };
})();
