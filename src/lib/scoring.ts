const STOPWORDS = new Set([
    "the","a","an","and","or","but","for","of","to","in","on","at","by","with","from","into","onto",
    "this","that","these","those","it","its","is","are","was","were","be","been","being","have","has",
    "had","do","does","did","will","would","can","could","should","shall","may","might","must","not",
    "no","yes","i","you","we","they","he","she","me","my","our","your","their","us","them","as","so",
    "if","then","else","when","while","how","why","what","which","who","whom","where","there","here",
    "please","help","need","want","try","let","get","use","make","just","some","any","all","only",
    "more","most","also","about","after","before","under","over","again","out","up","down","off",
    "very","really","ok","thanks","thank","okay","like","one","two","new","now","work","working",
    "fix","fixed","write","written","read","change","changed","add","added","create","created",
    "remove","removed","update","updated","run","running","test","testing","code","file","files",
])

export function tokenizeText(text: string): Map<string, number> {
    const counts = new Map<string, number>()
    const bump = (token: string) => {
        if (!token || token.length < 2) return
        if (STOPWORDS.has(token)) return
        counts.set(token, (counts.get(token) ?? 0) + 1)
    }
    const ascii = text.match(/[a-zA-Z0-9_]{2,}/g)
    for (const word of ascii ?? []) bump(word.toLowerCase())
    const cjk = text.match(/[\u3400-\u9fff]{2,}/g)
    for (const seg of cjk ?? []) {
        for (let i = 0; i + 1 < seg.length; i++) bump(seg.slice(i, i + 2))
    }
    return counts
}

export function tokenizePath(path: string): Map<string, number> {
    const counts = new Map<string, number>()
    const bump = (token: string) => {
        if (!token || token.length < 2) return
        counts.set(token, (counts.get(token) ?? 0) + 1)
    }
    const parts = path.split("/")
    const base = parts[parts.length - 1] ?? ""
    const stem = base.replace(/\.[^.]*$/, "").toLowerCase()
    bump(stem)
    for (const word of stem.match(/[a-zA-Z0-9_]+/g) ?? []) bump(word)
    for (const part of parts) bump(part.toLowerCase())
    return counts
}

export function mergeTokenMaps(...maps: Map<string, number>[]): Map<string, number> {
    const out = new Map<string, number>()
    for (const map of maps) {
        for (const [key, value] of map) out.set(key, (out.get(key) ?? 0) + value)
    }
    return out
}

export function docTokenSize(tokens: Map<string, number>): number {
    let sum = 0
    for (const v of tokens.values()) sum += v
    return sum
}

export function computeIdf(docs: Map<string, number>[], totalDocs: number): Map<string, number> {
    const df = new Map<string, number>()
    for (const doc of docs) {
        for (const term of doc.keys()) df.set(term, (df.get(term) ?? 0) + 1)
    }
    const idf = new Map<string, number>()
    for (const [term, count] of df) {
        idf.set(term, Math.log(1 + (totalDocs - count + 0.5) / (count + 0.5)))
    }
    return idf
}

const K1 = 1.2
const B = 0.75

export function bm25Score(
    query: Map<string, number>,
    doc: Map<string, number>,
    idf: Map<string, number>,
    docLen: number,
    avgDocLen: number,
): number {
    const avg = Math.max(avgDocLen, 1)
    let score = 0
    for (const [term, qf] of query) {
        const tf = doc.get(term) ?? 0
        if (tf === 0) continue
        const idfValue = idf.get(term) ?? 0
        score += qf * idfValue * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (docLen / avg))))
    }
    return score
}

export function recencyScore(deltaTurn: number, halfLife: number): number {
    return Math.exp(-Math.max(0, deltaTurn) / Math.max(1, halfLife))
}

export function fileOverlap(a: string[], b: string[]): number {
    if (a.length === 0 || b.length === 0) return 0
    const setA = new Set(a)
    let common = 0
    for (const p of b) if (setA.has(p)) common++
    return common / Math.max(Math.min(a.length, b.length), 1)
}

/** Cosine similarity over token maps, bounded [0, 1]. */
export function tokenSimilarity(a: Map<string, number>, b: Map<string, number>): number {
    if (a.size === 0 || b.size === 0) return 0
    let common = 0
    for (const [key, value] of a) {
        const other = b.get(key)
        if (other !== undefined) common += Math.min(value, other)
    }
    const norm = Math.sqrt(docTokenSize(a) * docTokenSize(b))
    return norm === 0 ? 0 : common / norm
}