/**
 * Parse Opay notification email
 * @param {string} emailBody 
 * @returns {object} transaction object matching transactions schema
 */
export function parseOpayEmail(emailBody) {
  if (!emailBody || typeof emailBody !== 'string') {
    return null;
  }

  const isCredit = emailBody.toLowerCase().includes('received') || emailBody.toLowerCase().includes('credited');
  const type = isCredit ? 'credit' : 'debit';

  // Amount from header or transfer details
  // "Your transfer of ₦2,600.00 is successful."
  // "Amount:           ₦2,600.00"
  const amountMatch = emailBody.match(/(?:transfer of|Amount\s*:)\s*₦?\s*([\d,.]+)/i);
  let amount = 0;
  if (amountMatch) {
    amount = parseFloat(amountMatch[1].replace(/,/g, '')) || 0;
  }

  // Available balance: "Your available balance is ₦5,808.09."
  const availMatch = emailBody.match(/available balance is\s*₦?\s*([\d,.]+)/i);
  let available_balance = null;
  if (availMatch) {
    available_balance = parseFloat(availMatch[1].replace(/,/g, '')) || 0;
  }

  // Name / Recipient: "Name:             REJOICE ENE JOSEPH"
  const nameMatch = emailBody.match(/Name\s*:\s*([^\n\r]+)/i);
  const recipient = nameMatch ? nameMatch[1].trim() : null;

  // Bank: "Bank:             United Bank For Africa"
  const bankMatch = emailBody.match(/Bank\s*:\s*([^\n\r]+)/i);
  const recipient_bank = bankMatch ? bankMatch[1].trim() : null;

  // Transaction No: "Transaction No.:  260730020100173482925656"
  const txMatch = emailBody.match(/Transaction No\.\s*:\s*([A-Za-z0-9]+)/i);
  const transaction_id = txMatch ? txMatch[1].trim() : null;

  // Transaction Date: "Transaction Date: Jul 30th, 2026 10:30:09"
  const dateMatch = emailBody.match(/Transaction Date\s*:\s*([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,\s*(\d{4})\s+(\d{1,2}:\d{2}:\d{2})/i);
  let transaction_date = new Date().toISOString().split('T')[0];
  let transaction_time = '10:30:00';

  if (dateMatch) {
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const monthIdx = monthNames.findIndex(m => m.toLowerCase() === dateMatch[1].toLowerCase());
    const mStr = monthIdx !== -1 ? String(monthIdx + 1).padStart(2, '0') : '01';
    const dayStr = String(dateMatch[2]).padStart(2, '0');
    const yearStr = dateMatch[3];
    transaction_date = `${yearStr}-${mStr}-${dayStr}`;
    transaction_time = dateMatch[4];
  }

  // Auto categorization
  let category = 'Uncategorized';
  let confidence = 'LOW';
  const fullText = (recipient + ' ' + (recipient_bank || '') + ' ' + emailBody).toUpperCase();

  if (fullText.includes('ELECTRICITY') || fullText.includes('IKEDC') || fullText.includes('AEDC') || fullText.includes('UTILITY')) {
    category = 'Electricity';
    confidence = 'HIGH';
  } else if (fullText.includes('AIRTIME') || fullText.includes('MTN') || fullText.includes('GLO') || fullText.includes('AIRTEL') || fullText.includes('9MOBILE')) {
    category = 'Airtime & Data';
    confidence = 'HIGH';
  } else if (recipient && !fullText.includes('LIMITED') && !fullText.includes('INC') && !fullText.includes('LTD')) {
    category = 'Family Support';
    confidence = 'HIGH';
  }

  const description = recipient ? `Transfer to ${recipient}${recipient_bank ? ` (${recipient_bank})` : ''}` : 'Opay Transfer';

  return {
    type,
    amount,
    currency: 'NGN',
    source: 'opay',
    category,
    description,
    recipient,
    available_balance,
    transaction_date,
    transaction_time,
    transaction_id,
    confidence,
    reviewed: false,
    raw_email: emailBody,
  };
}
