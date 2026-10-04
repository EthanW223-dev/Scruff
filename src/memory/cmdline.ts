/** Splits a Windows command line into arguments the way programs see them (CommandLineToArgvW's rules). */
export function splitWindowsCommandLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  let started = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\") {
      let n = 0;
      while (line[i + n] === "\\") n++;
      if (line[i + n] === '"') {
        // 2n backslashes + quote: n backslashes and a quote mark; 2n+1: n backslashes and a literal quote.
        cur += "\\".repeat(Math.floor(n / 2));
        if (n % 2) cur += '"';
        else quoted = !quoted;
        i += n;
      } else {
        cur += "\\".repeat(n);
        i += n - 1;
      }
      started = true;
    } else if (c === '"') {
      quoted = !quoted;
      started = true;
    } else if (!quoted && (c === " " || c === "\t")) {
      if (started) out.push(cur);
      cur = "";
      started = false;
    } else {
      cur += c;
      started = true;
    }
  }
  if (started) out.push(cur);
  return out;
}
