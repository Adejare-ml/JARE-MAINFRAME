/**
 * Parse GTBank notification email
 * @param {string} emailBody 
 * @returns {object} transaction object matching transactions schema
 */
export function parseGTBankEmail(emailBody) {
  if (!emailBody || typeof emailBody !== 'string') {
    return null;
  }

  const isDebit = emailBody.includes('DEBIT transaction');
  const type = isDebit ? 'debit' : 'credit';

  // Every field below matches with [ \t]* after the colon rather than \s*.
  // GTBank leaves fields blank on some alerts -- charge and stamp-duty emails
  // ship an empty Document Number -- and \s* happily crosses the newline and
  // captures the *next* label's value. That gave every charge email the same
  // transaction_id ("Available", off the Available Balance line), so the first
  // one inserted and every later one was silently discarded as a duplicate.
  // A blank field must parse as absent.

  // Amount: "Amount              : NGN 20000" or "NGN 20,000.00"
  const amountMatch = emailBody.match(/Amount[ \t]*:[ \t]*NGN[ \t]*([\d,.]+)/i);
  let amount = 0;
  if (amountMatch) {
    amount = parseFloat(amountMatch[1].replace(/,/g, '')) || 0;
  }

  // Description: "Description         : ..."
  const descMatch = emailBody.match(/Description[ \t]*:[ \t]*([\s\S]*?)(?=\n\s*(?:Amount|Value Date|Remarks|Time of Transaction|Document Number|Available Balance)|$)/i);
  const description = descMatch ? descMatch[1].replace(/\s+/g, ' ').trim() : '';

  // Recipient / Sender extraction
  let recipient = null;
  if (isDebit) {
    const toMatch = description.match(/\bTO\s+([A-Z\s,]+?)(?=\s+FROM|\s+ON|\s+FOR|$)/i);
    if (toMatch) recipient = toMatch[1].trim();
  } else {
    const fromMatch = description.match(/\bFROM\s+([A-Z\s,]+?)(?=\s+TO|\s+ON|\s+FOR|$)/i);
    if (fromMatch) recipient = fromMatch[1].trim();
  }

  // Date: "Value Date          : 2026-07-29"
  const dateMatch = emailBody.match(/Value Date[ \t]*:[ \t]*(\d{4}-\d{2}-\d{2})/i);
  let transaction_date = dateMatch ? dateMatch[1] : new Date().toISOString().split('T')[0];

  // Time: "Time of Transaction : 8:02:23 PM"
  const timeMatch = emailBody.match(/Time of Transaction[ \t]*:[ \t]*(\d{1,2}:\d{2}:\d{2}[ \t]*(?:AM|PM)?)/i);
  let transaction_time = '12:00:00';
  if (timeMatch) {
    const timeStr = timeMatch[1].trim();
    if (timeStr.includes('AM') || timeStr.includes('PM')) {
      const [t, modifier] = timeStr.split(/\s+/);
      let [hours, minutes, seconds] = t.split(':');
      let h = parseInt(hours, 10);
      if (modifier.toUpperCase() === 'PM' && h < 12) h += 12;
      if (modifier.toUpperCase() === 'AM' && h === 12) h = 0;
      transaction_time = `${String(h).padStart(2, '0')}:${minutes}:${seconds || '00'}`;
    } else {
      transaction_time = timeStr;
    }
  }

  // Available Balance: "Available Balance   : NGN 50000.7"
  const availMatch = emailBody.match(/Available Balance[ \t]*:[ \t]*NGN[ \t]*([\d,.]+)/i);
  let available_balance = null;
  if (availMatch) {
    available_balance = parseFloat(availMatch[1].replace(/,/g, '')) || 0;
  }

  // Document Number / Transaction ID: "Document Number     : 044884719406769l5872"
  const docMatch = emailBody.match(/Document Number[ \t]*:[ \t]*([A-Za-z0-9]+)[ \t]*$/im);
  const transaction_id = docMatch ? docMatch[1].trim() : null;

  // Auto categorization
  const upperDesc = description.toUpperCase();
  let category = 'Uncategorized';
  let confidence = 'LOW';

  if (upperDesc.includes('GTWORLD') && recipient) {
    category = 'Family Support';
    confidence = 'HIGH';
  } else if (upperDesc.includes('ATM')) {
    category = 'Cash Withdrawal';
    confidence = 'HIGH';
  } else if (upperDesc.includes('AIRTIME')) {
    category = 'Airtime & Data';
    confidence = 'HIGH';
  } else if (upperDesc.includes('ELECTRICITY') || upperDesc.includes('IKEDC') || upperDesc.includes('AEDC') || upperDesc.includes('EKEDC')) {
    category = 'Electricity';
    confidence = 'HIGH';
  } else if (upperDesc.includes('POS')) {
    category = 'Feeding / Groceries';
    confidence = 'HIGH';
  }

  return {
    type,
    amount,
    currency: 'NGN',
    source: 'gtbank',
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
