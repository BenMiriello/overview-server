// Copied from Blitzortung.org index.js - LZW decoding function
function decode(message) {
  try {
    let dict = {};
    let data = message.split('');
    let currChar = data[0];
    let oldPhrase = currChar;
    let out = [currChar];
    let code = 256;
    let phrase;
    for (let i = 1; i < data.length; i++) {
      let currCode = data[i].charCodeAt(0);

      if (currCode < 256) {
        phrase = data[i];
      } else {
        phrase = dict[currCode] ? dict[currCode] : (oldPhrase + currChar);
      }

      out.push(phrase);
      currChar = phrase.charAt(0);
      dict[code] = oldPhrase + currChar;
      code++;
      oldPhrase = phrase;
    }

    return out.join('');
  } catch (error) {
    console.error('Error in decode function:', error);
    return message; // Return original message if decoding fails
  }
}

const logStreamData = process.env.LOG_STREAM_DATA === 'true';
const verbose       = process.env.VERBOSE         === 'true';

module.exports = {
  decode,
  logStreamData,
  verbose,
};
