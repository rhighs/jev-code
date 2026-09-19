export function sanitizedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.TYPESAFE_API_KEY;
  return env;
}
