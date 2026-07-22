export function generateRoomCode(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

export function buildViewerUrl(baseUrl: string, roomCode: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set('room', roomCode);
  url.searchParams.set('type', 'voter');
  return url.toString();
}

export function getHostPeerId(roomCode: string): string {
  return `poker-${roomCode}`;
}
