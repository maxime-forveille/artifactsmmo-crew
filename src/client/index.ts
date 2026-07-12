import { env } from "../utils/config.js";
import { logger } from "../utils/logger.js";

const API_BASE_URL = "https://api.artifactsmmo.com";

export class ArtifactsApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = "ArtifactsApiError";
  }
}

export type ArtifactsClient = {
  getCharacter: (name: string) => Promise<unknown>;
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
};

/**
 * Thin wrapper around the Artifacts MMO REST API.
 * @see https://docs.artifactsmmo.com/
 */
export const createArtifactsClient = (token: string = env.ARTIFACTS_TOKEN): ArtifactsClient => {
  const request = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const url = `${API_BASE_URL}${path}`;

    const response = await fetch(url, {
      ...init,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });

    if (!response.ok) {
      const body = await response.json().catch(() => undefined);
      logger.error({ body, status: response.status, url }, "Artifacts API request failed");
      throw new ArtifactsApiError(
        `Artifacts API request failed: ${response.status} ${response.statusText}`,
        response.status,
        body,
      );
    }

    return (await response.json()) as T;
  };

  const getCharacter = (name: string) => request(`/characters/${name}`);

  return { getCharacter, request };
};

export const bot = createArtifactsClient();
