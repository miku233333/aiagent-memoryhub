export const MEMORY_HUB_SESSION_PARTITION = "memoryhub-app";

interface MemoryHubSession {
  getStoragePath(): string | null;
  isPersistent(): boolean;
}

interface SessionFactory<SessionType extends MemoryHubSession> {
  fromPartition(
    partition: string,
    options: { cache: boolean },
  ): SessionType;
}

export function createMemoryHubSession<SessionType extends MemoryHubSession>(
  factory: SessionFactory<SessionType>,
): SessionType {
  const applicationSession = factory.fromPartition(
    MEMORY_HUB_SESSION_PARTITION,
    { cache: false },
  );
  if (applicationSession.isPersistent()) {
    throw new Error("MemoryHub renderer session must be in-memory");
  }
  if (applicationSession.getStoragePath() !== null) {
    throw new Error("MemoryHub renderer session must not have a storage path");
  }
  return applicationSession;
}
