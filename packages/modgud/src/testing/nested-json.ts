// The one way tests build JSON nested too deeply to handle recursively.

// The JSON text of a value nested `levels` levels deep, the value itself being
// the first and the innermost an empty object. Levels alternate between
// objects and, at every third level, arrays. It is text because stringifying
// a value 100,000 levels deep would overflow the stack; `JSON.parse` of the
// text gives the value form for a depth small enough to parse.
export const nestedJson = (levels: number) => {
  const opens: string[] = [];
  const closes: string[] = [];
  for (let level = 1; level < levels; level += 1) {
    opens.push(level % 3 === 0 ? '[' : '{"a":');
    closes.push(level % 3 === 0 ? ']' : '}');
  }
  return `${opens.join('')}{}${closes.toReversed().join('')}`;
};
