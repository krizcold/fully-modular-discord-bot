import * as os from 'os';

export function getNodeName(): string {
  return (process.env.NODE_NAME || '').trim() || os.hostname();
}
