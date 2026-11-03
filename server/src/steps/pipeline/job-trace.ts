const READABLE_LINES = 200;
const READABLE_CHARS = 20000;

export function readableJobTrace(raw: string): string {
  const rawLines = raw.split(/\r?\n/);
  const section = rawLines.findIndex((line) => line.includes('section_end:') && line.includes('step_script'));
  let end = rawLines.length;
  if (section >= 0) {
    end = section + 1;
  } else {
    for (let index = rawLines.length - 1; index >= 0; index -= 1) {
      if (rawLines[index].includes('##[error]')) {
        end = index + 1;
        break;
      }
    }
  }
  return cleanTrace(rawLines.slice(0, end).join('\n')).slice(-READABLE_LINES).join('\n').slice(-READABLE_CHARS);
}

function cleanTrace(raw: string): string[] {
  return (
    raw
      // eslint-disable-next-line no-control-regex -- strips terminal escape sequences that the job log carries
      .replace(/\u001b(?:\[[0-9;?]*[A-Za-z]|\][^\u0007]*(?:\u0007|\u001b\\))/g, '')
      .split(/\r?\n/)
      .map((line) => line.replace(/\r$/, '').replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z /, ''))
      .filter((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'trace truncated') {
          return false;
        }
        if (trimmed.includes('section_start:') || trimmed.includes('section_end:')) {
          return false;
        }
        if (/^[.*]+$/.test(trimmed) || /^\* test /.test(trimmed)) {
          return false;
        }
        if (/^Compiling \d+ files/.test(trimmed) || /^Generated /.test(trimmed)) {
          return false;
        }
        return true;
      })
  );
}
