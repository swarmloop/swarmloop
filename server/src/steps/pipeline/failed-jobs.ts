/** One failed job of a pipeline_log: the project it ran in, its name and its block of the log. */
export interface FailedJob {
  project: string;
  job: string;
  text: string;
}

/** The `project:` blocks of a failed log that name a job, each with its own text. */
export function failedJobs(log: string): FailedJob[] {
  const lines = log.split('\n');
  const starts = lines.flatMap((line, index) =>
    line.startsWith('project: ') && lines[index + 1]?.startsWith('pipeline: ') ? [index] : [],
  );
  return starts.flatMap((start, at) => {
    const block = lines.slice(start, starts[at + 1] ?? lines.length);
    const job = block.find((line) => line.startsWith('job: '));
    return job
      ? [
          {
            project: block[0].slice('project: '.length).trim(),
            job: job.slice('job: '.length).trim(),
            text: block.join('\n'),
          },
        ]
      : [];
  });
}
