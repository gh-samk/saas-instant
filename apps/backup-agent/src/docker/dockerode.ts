import os from 'node:os';
import { PassThrough, type Readable } from 'node:stream';
import Docker from 'dockerode';
import type { ContainerRef, DockerClient, ExecHandle } from './types.js';

const PROJECT_LABEL = 'com.docker.compose.project';
const SERVICE_LABEL = 'com.docker.compose.service';
const MAX_STDERR = 8192;

function toRef(c: Docker.ContainerInfo): ContainerRef {
  return {
    id: c.Id,
    project: c.Labels?.[PROJECT_LABEL] ?? '',
    service: c.Labels?.[SERVICE_LABEL] ?? '',
    running: c.State === 'running',
  };
}

export function dockerFromEnv(hostUrl: string): Docker {
  const m = /^tcp:\/\/([^:/]+):(\d+)$/.exec(hostUrl);
  if (m) return new Docker({ host: m[1], port: Number(m[2]) });
  if (hostUrl.startsWith('unix://')) return new Docker({ socketPath: hostUrl.slice(7) });
  throw new Error('DOCKER_HOST hat ein unbekanntes Format');
}

export class DockerodeClient implements DockerClient {
  constructor(private readonly docker: Docker) {}

  async listProject(project: string): Promise<ContainerRef[]> {
    const list = await this.docker.listContainers({ all: true, filters: { label: [`${PROJECT_LABEL}=${project}`] } });
    // Doppelt pruefen: nur Container, deren Label wirklich dem Projekt entspricht.
    return list.map(toRef).filter((c) => c.project === project);
  }

  async findContainer(project: string, service: string): Promise<ContainerRef | null> {
    const list = await this.listProject(project);
    return list.find((c) => c.service === service) ?? null;
  }

  async ownProject(): Promise<string | null> {
    try {
      const info = await this.docker.getContainer(os.hostname()).inspect();
      return info.Config?.Labels?.[PROJECT_LABEL] ?? null;
    } catch {
      return null;
    }
  }

  async start(id: string): Promise<void> {
    try {
      await this.docker.getContainer(id).start();
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode !== 304) throw e;
    }
  }

  async stop(id: string): Promise<void> {
    try {
      await this.docker.getContainer(id).stop({ t: 30 });
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode !== 304) throw e;
    }
  }

  exec(id: string, cmd: string[], opts?: { stdin?: Readable }): ExecHandle {
    const stdout = new PassThrough();
    const stderrParts: Buffer[] = [];
    let stderrLen = 0;
    const stderr = new PassThrough();
    stderr.on('data', (c: Buffer) => {
      if (stderrLen < MAX_STDERR) {
        stderrParts.push(c);
        stderrLen += c.length;
      }
    });
    const done = (async () => {
      try {
        const exec = await this.docker.getContainer(id).exec({
          Cmd: cmd,
          AttachStdin: !!opts?.stdin,
          AttachStdout: true,
          AttachStderr: true,
          Tty: false,
        });
        const stream = await exec.start({ hijack: !!opts?.stdin, stdin: !!opts?.stdin });
        this.docker.modem.demuxStream(stream, stdout, stderr);
        if (opts?.stdin) opts.stdin.pipe(stream);
        await new Promise<void>((resolve, reject) => {
          stream.on('end', resolve);
          stream.on('close', resolve);
          stream.on('error', reject);
        });
        stdout.end();
        stderr.end();
        const info = await exec.inspect();
        return {
          exitCode: info.ExitCode ?? -1,
          stderr: Buffer.concat(stderrParts).toString('utf8').slice(0, MAX_STDERR),
        };
      } catch (e) {
        stdout.destroy(e instanceof Error ? e : new Error('Docker-Fehler'));
        throw e;
      }
    })();
    done.catch(() => undefined);
    return { stdout, done };
  }
}
