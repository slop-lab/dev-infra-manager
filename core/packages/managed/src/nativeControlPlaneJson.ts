export function hasDuplicateJsonKeys(text: string): boolean {
  const stack: Array<{ keys: Set<string> | undefined; keyExpected: boolean }> = [];
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "{") {
      stack.push({ keys: new Set(), keyExpected: true });
    } else if (character === "[") {
      stack.push({ keys: undefined, keyExpected: false });
    } else if (character === "}" || character === "]") {
      stack.pop();
    } else if (character === ",") {
      const top = stack.at(-1);
      if (top?.keys !== undefined) top.keyExpected = true;
    } else if (character === '"') {
      const start = index;
      index += 1;
      while (index < text.length) {
        if (text[index] === "\\") {
          index += 2;
          continue;
        }
        if (text[index] === '"') break;
        index += 1;
      }
      const top = stack.at(-1);
      if (top?.keys !== undefined && top.keyExpected) {
        const key: unknown = JSON.parse(text.slice(start, index + 1));
        if (typeof key !== "string" || top.keys.has(key)) return true;
        top.keys.add(key);
        top.keyExpected = false;
      }
    }
  }
  return false;
}
