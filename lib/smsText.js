// Moved verbatim from index.js.
// Keep messages plain ASCII: any non-GSM character switches the SMS to UCS-2,
// which cuts a credit down to 70 characters.
function toSmsText(str) {
  return String(str || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\x20-\x7E]/g, "")
    .trim();
}

module.exports = { toSmsText };
