import type { Readable } from 'node:stream';

export interface ContainerRef {
  id: string;
  project: string;
  service: string;
  running: boolean;
}

export interface ExecResult {
  exitCode: number;
  /** Gekappt; kann Fehlertext des Werkzeugs enthalten, wird vor Ausgabe geschwaerzt. */
  stderr: string;
}

export interface ExecHandle {
  stdout: Readable;
  done: Promise<ExecResult>;
}

/** Schmale Docker-Schnittstelle. Echt: dockerode ueber den docker-socket-proxy; Tests: Fake. */
export interface DockerClient {
  findContainer(project: string, service: string): Promise<ContainerRef | null>;
  listProject(project: string): Promise<ContainerRef[]>;
  exec(containerId: string, cmd: string[], opts?: { stdin?: Readable }): ExecHandle;
  start(containerId: string): Promise<void>;
  stop(containerId: string): Promise<void>;
  /** Compose-Projekt des eigenen Containers (oder null, wenn nicht ermittelbar). */
  ownProject(): Promise<string | null>;
}
