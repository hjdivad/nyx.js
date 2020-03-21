import * as path from 'path';
import { Polly, PollyConfig, Headers } from '@pollyjs/core';
import NodeHttpAdapter from '@pollyjs/adapter-node-http';
import FSPersister from '@pollyjs/persister-fs';
import reportFailure from './report-failure';
import setupHardRejection from 'hard-rejection';
import { Archive } from '@tracerbench/har';
import { Octokit } from '@octokit/rest';

const GITHUB_AUTH = process.env.GITHUB_AUTH;

declare module '@pollyjs/persister' {
  export default interface Persister {
    findRecording(recordingId: string): Archive;

    saveRecording(recordingId: string, data: Archive): void;

    deleteRecording(recordingId: string): void;
  }
}

class SanitizingPersister extends FSPersister {
  static get id(): string {
    return 'sanitizing-fs';
  }

  get options(): PollyConfig['persisterOptions'] {
    return {
      recordingsDir: path.resolve(__dirname, '..', '..', '.recordings'),
    };
  }

  // ensure that the authorization token is not written to disk
  saveRecording(recordingId: string, data: Archive): void {
    data.log.entries.forEach(entry => {
      entry.request.headers = entry.request.headers.filter(h => h.name !== 'authorization');
    });

    return super.saveRecording(recordingId, data);
  }
}

setupHardRejection();

Polly.register(NodeHttpAdapter);

describe('src/commands/report-failure.ts', function() {
  let polly: Polly;
  let github: Octokit;

  function setupPolly(recordingName: string, config: PollyConfig = {}): Polly {
    polly = new Polly(recordingName, {
      adapters: ['node-http'],
      persister: SanitizingPersister,
      matchRequestsBy: {
        headers(headers: Headers): Headers {
          // ensure that the authorization token is not used to match
          // recordings
          const { authorization, ...rest } = headers;

          return rest;
        },
      },
      ...config,
    });

    return polly;
  }

  beforeEach(() => {
    github = new Octokit({
      auth: GITHUB_AUTH,
      userAgent: '@malleatus/nyx failure reporter',
    });
  });

  afterEach(async () => {
    if (polly) {
      await polly.stop();
    }
  });

  test('creates an issue', async function() {
    setupPolly('basic-test');

    let issues = await github.issues.listForRepo({
      owner: 'malleatus',
      repo: 'nyx-example',
      labels: 'CI',
      state: 'open',
    });

    expect(issues.data.length).toEqual(0);

    await reportFailure({
      env: {
        OWNER: 'malleatus',
        REPO: 'nyx-example',
        RUN_ID: '123456',
        GITHUB_TOKEN: GITHUB_AUTH,
      },
    });

    issues = await github.issues.listForRepo({
      owner: 'malleatus',
      repo: 'nyx-example',
      labels: 'CI',
      state: 'open',
    });

    expect(issues.data.length).toEqual(1);
  });
});
