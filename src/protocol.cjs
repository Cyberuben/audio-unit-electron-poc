// Paths and process lifecycle operations are reserved for the main process.
const commands = new Set(['play', 'pause', 'restart', 'loop', 'bypass', 'mix', 'trim']);
function validateCommand(message) {
  if (!message || !commands.has(message.command)) throw new Error('Unsupported audio command');
  const { command, value } = message;
  if (command === 'trim') {
    const { start, end } = message;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
      throw new Error('Invalid trim range');
    }
    return { command, start, end };
  }
  if (['loop', 'bypass'].includes(command) && typeof value !== 'boolean')
    throw new Error('Expected boolean');
  if (command === 'mix' && (!Number.isFinite(value) || value < -100 || value > 100))
    throw new Error('Invalid mix');
  return ['loop', 'bypass', 'mix'].includes(command) ? { command, value } : { command };
}
module.exports = { validateCommand };
