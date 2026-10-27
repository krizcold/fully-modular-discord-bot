import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const repo = path.resolve(__dirname, '..', '..');
const startSh = fs.readFileSync(path.join(repo, 'start.sh'), 'utf8');

describe('start.sh rebuild completion', () => {
  it('drops the applied stamp before the rebuild touches dist', () => {
    const branch = startSh.indexOf('rebuilding /app/build and /app/dist');
    const drop = startSh.indexOf('rm -f /data/applied-version.json', branch);
    const stage = startSh.indexOf('stage_sources', branch);
    expect(branch).toBeGreaterThan(0);
    expect(drop).toBeGreaterThan(branch);
    expect(drop).toBeLessThan(stage);
  });

  it('syncs dist, writes the stamp through a temp file, and writes the marker in dist last', () => {
    const info = startSh.indexOf('build-info.js\',\'window.BOT_BUILD');
    const sync = startSh.indexOf('\n    sync\n', info);
    const tmp = startSh.indexOf('/data/applied-version.json.tmp', info);
    const mv = startSh.indexOf('mv /data/applied-version.json.tmp /data/applied-version.json', info);
    const marker = startSh.indexOf('/app/dist/.build-complete', mv);
    expect(info).toBeGreaterThan(0);
    expect(sync).toBeGreaterThan(info);
    expect(tmp).toBeGreaterThan(sync);
    expect(mv).toBeGreaterThan(tmp);
    expect(marker).toBeGreaterThan(mv);
  });

  it('reuses dist only with the marker for this buildId and a non-empty index.js', () => {
    const cond = startSh.split('\n').find(l => l.startsWith('if [ "$IMAGE_BUILD_ID" != "$APPLIED_BUILD_ID" ]')) ?? '';
    expect(cond).toContain('[ ! -s /app/dist/index.js ]');
    expect(cond).toContain('$BUILD_COMPLETE_ID');
    expect(startSh).toContain('the previous build is not on disk whole; rebuilding');
  });
});

describe('the compose overlay description', () => {
  it('says when /app/custom is applied', () => {
    const compose = fs.readFileSync(path.join(repo, 'docker-compose.yml'), 'utf8');
    expect(compose).toContain('Applied when the container is rebuilt: a new image or a recreate; a plain restart keeps the previous build');
  });
});
