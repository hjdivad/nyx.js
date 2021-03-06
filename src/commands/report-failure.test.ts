import * as path from 'path';
import { Polly, PollyConfig, Headers } from '@pollyjs/core';
import NodeHttpAdapter from '@pollyjs/adapter-node-http';
import FSPersister from '@pollyjs/persister-fs';
import reportFailure from './report-failure';
import setupHardRejection from 'hard-rejection';
import { Archive } from '@tracerbench/har';
import { Octokit } from '@octokit/rest';
import FakeTimers, { FakeClock } from '@sinonjs/fake-timers';

const GITHUB_AUTH = process.env.GITHUB_AUTH_MALLEATUS_USER_A;

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
    data.log.entries.forEach((entry) => {
      entry.request.headers = entry.request.headers.filter((h) => h.name !== 'authorization');
    });

    return super.saveRecording(recordingId, data);
  }
}

setupHardRejection();

Polly.register(NodeHttpAdapter);

describe('src/commands/report-failure.ts', function () {
  let polly: Polly;
  let github: Octokit;
  let clock: FakeClock;

  function setupPolly(recordingName: string, config: PollyConfig = {}): Polly {
    polly = new Polly(recordingName, {
      adapters: ['node-http'],
      persister: SanitizingPersister,
      recordIfMissing: process.env.RECORD_HAR !== undefined,
      matchRequestsBy: {
        headers(headers: Headers): Headers {
          /*
            remove certain headers from being used to match recordings:

            * authorization -- Avoid saving any authorization codes into
              `.har` files, and avoid differences when two different users run
              the tests
            * user-agent -- @octokit/rest **always** appends Node version and
              platform information into the userAgent (even when the Octokit
              instance has a custom userAgent). See
              https://github.com/octokit/rest.js/issues/907#issuecomment-422217573
              for a quick summary.
          */
          const { authorization, 'user-agent': userAgent, ...rest } = headers;

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
    clock = FakeTimers.install({
      now: new Date('3 April 1994 13:14 GMT'),
    });
  });

  afterEach(async () => {
    if (polly) {
      await polly.stop();
    }
    clock.uninstall();
  });

  test('creates an issue', async function () {
    setupPolly('basic-test');

    let issues = await github.issues.listForRepo({
      owner: 'malleatus',
      repo: 'nyx-example',
      labels: 'CI',
      state: 'open',
    });

    expect(issues.data.length).toEqual(0);

    await reportFailure({
      owner: 'malleatus',
      repo: 'nyx-example',
      runId: '123456',
      token: GITHUB_AUTH || 'fake-auth-token',
    });

    issues = await github.issues.listForRepo({
      owner: 'malleatus',
      repo: 'nyx-example',
      labels: 'CI',
      state: 'open',
    });

    // TODO: clean up the cleanup
    for (let issue of issues.data) {
      await github.issues.update({
        owner: 'malleatus',
        repo: 'nyx-example',
        // eslint-disable-next-line @typescript-eslint/camelcase
        issue_number: issue.number,
        state: 'closed',
      });
    }

    expect(issues.data.length).toEqual(1);
  });
});
