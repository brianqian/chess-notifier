export type Env = {
  STATE: KVNamespace;
  CHESS_USERNAME: string;
  EMAIL_TO: string;
  EMAIL_FROM: string;
  RESEND_API_KEY: string;
  TRIGGER_SECRET: string;
  LICHESS_TOKEN?: string;
  PUBLIC_URL?: string;
};
