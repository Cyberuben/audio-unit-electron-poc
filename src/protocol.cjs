// Loading files and quitting are reserved for the main process, not renderer commands.
const commands = new Set(['play', 'pause', 'restart', 'loop', 'bypass', 'mix']);
function validateCommand(message) {
  if (!message || !commands.has(message.command)) throw new Error('Unsupported audio command');
  const { command, value } = message;
  if (['loop', 'bypass'].includes(command) && typeof value !== 'boolean')
    throw new Error('Expected boolean');
  if (
    command === 'mix' &&
    (typeof value !== 'number' || !Number.isFinite(value) || value < -100 || value > 100)
  )
    throw new Error('Invalid mix');
  // Reconstruct the payload so extra renderer-supplied fields never reach the helper.
  return ['loop', 'bypass', 'mix'].includes(command) ? { command, value } : { command };
}
module.exports = { validateCommand };
