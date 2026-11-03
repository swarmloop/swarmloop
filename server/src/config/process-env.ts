/** The raw process environment. Only for code that runs without Nest injection; services read `AppConfig`. */
export function rawEnv(): NodeJS.ProcessEnv {
  return process.env;
}
