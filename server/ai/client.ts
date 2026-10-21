import Anthropic from '@anthropic-ai/sdk';

/** The slice of the SDK the describe service uses; tests inject a fake. */
export interface AiMessageStream {
  finalMessage(): Promise<Anthropic.Message>;
}
export interface AiClient {
  stream(params: Anthropic.MessageStreamParams): AiMessageStream;
}
/** `apiKey` null: let the SDK resolve credentials itself (ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / `ant` profile). */
export type AiClientFactory = (apiKey: string | null) => AiClient;

export const anthropicClientFactory: AiClientFactory = (apiKey) => {
  const client = apiKey ? new Anthropic({ apiKey }) : new Anthropic();
  return { stream: (params) => client.messages.stream(params) };
};
