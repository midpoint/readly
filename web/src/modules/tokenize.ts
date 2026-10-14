const STOPWORDS = new Set([
  // 中文高频虚词
  "的", "了", "是", "在", "和", "与", "及", "或", "而", "之", "其", "这", "那", "一个", "我们", "他们",
  "你们", "以及", "对于", "关于", "但是", "因为", "所以", "如果", "已经", "可以", "进行", "通过", "根据",
  "表示", "认为", "显示", "记者", "报道", "消息", "今天", "昨天", "明天", "目前", "同时", "此外", "其中",
  // 英文停用词
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "her", "was", "one", "our", "out",
  "day", "get", "has", "him", "his", "how", "its", "new", "now", "old", "see", "two", "way", "who",
  "boy", "did", "man", "men", "put", "say", "she", "too", "use", "that", "with", "have", "this",
  "will", "your", "from", "they", "been", "were", "said", "each", "which", "their", "them", "than",
  "into", "more", "other", "some", "what", "when", "where", "about", "would", "there", "could",
  "first", "after", "these", "those", "being", "under", "while", "should", "before", "between",
]);

export function tokenize(text: string): string[] {
  const cleaned = text.replace(/https?:\/\/\S+/gi, " ").replace(/\d+/g, " ");
  const tokens: string[] = [];
  const cjkRuns = cleaned.match(/[一-鿿]+/g) ?? [];
  for (const run of cjkRuns) {
    if (run.length === 1) {
      tokens.push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2));
  }
  const latinWords = cleaned.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? [];
  for (const w of latinWords) {
    if (!STOPWORDS.has(w)) tokens.push(w);
  }
  return tokens.filter((t) => !STOPWORDS.has(t));
}
