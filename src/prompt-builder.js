/**
 * Builds a prompt from the provided context
 */

function buildPrompt(context) {
  const { message, file, line } = context;

  let parts = [];

  // Add file location if provided
  if (file) {
    let location = file;
    if (line) {
      location += `:${line}`;
    }
    parts.push(`Fix this error in ${location}`);
  } else {
    parts.push('Fix this error');
  }

  // Add the error message
  if (message) {
    parts.push(`- ${message}`);
  }

  return parts.join(' ');
}

module.exports = {
  buildPrompt
};
