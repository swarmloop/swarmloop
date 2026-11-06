/** The sections of a prompt by heading with their sizes in characters. The text before the first heading is `prompt`. */
export function promptSections(prompt: string): { heading: string; size: number }[] {
  const sections: { heading: string; size: number }[] = [];
  let heading = 'prompt';
  let size = 0;
  const lines = prompt.split('\n');
  lines.forEach((line, index) => {
    if (index > 0 && lines[index - 1] === '' && /^[A-Z][^:]{0,80}:$/.test(line)) {
      sections.push({ heading, size });
      heading = line.slice(0, -1);
      size = 0;
    }
    size += line.length + 1;
  });
  sections.push({ heading, size });
  return sections.filter((section) => section.size > 0);
}
