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
            if (a.length >= 4 && b.length >= 4) {
                let sim = similarity(a, b);
                if (a == b || (b.length >= 5 && sim >= 0.8) || (b.length >= 10 && sim >= 0.75))
                    return { correct: true, reason: 'sounds like ' + sim.toFixed(2), normalized: u, matched: v };
            }
        }
        return { correct: false, reason: 'no match', normalized: u, variants: vs };
    }

    // Sound folding: spellings that sound alike become one spelling, the words
    // run together, so a recognizer's homophone lands close to the real answer.
    function soundFold(text) {
        let t = ' ' + String(text).toLowerCase().replace(/[^a-z ]/g, '') + ' ';
        t = t.replace(/ph/g, 'f').replace(/ght/g, 't').replace(/gh /g, ' ').replace(/ck/g, 'k').replace(/sch/g, 'sk').replace(/tch/g, 'ch').replace(/sh/g, 'x').replace(/ch/g, 'x').replace(/th/g, 't')
             .replace(/c(?=[eiy])/g, 's').replace(/c/g, 'k').replace(/q/g, 'k').replace(/z/g, 's').replace(/dg/g, 'j').replace(/ wr/g, ' r').replace(/ kn/g, ' n').replace(/ gn/g, ' n').replace(/ ps/g, ' s').replace(/wh/g, 'w').replace(/mb /g, 'm ')
             .replace(/y/g, 'i').replace(/ea/g, 'e').replace(/ee/g, 'e').replace(/ie/g, 'e').replace(/oo/g, 'u').replace(/ou/g, 'u').replace(/au/g, 'o').replace(/aw/g, 'o').replace(/ai/g, 'a').replace(/ei/g, 'a').replace(/ey /g, 'e ').replace(/e (?=.)/g, ' ');
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

    return { normalize: normalize, variants: variants, judge: judge, judgeAny: judgeAny, similarity: similarity, stripHtml: stripHtml };
})();
