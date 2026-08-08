export const CATEGORIES = {
  'Essentials': [
    'Feeding / Groceries',
    'Transport',
    'Airtime & Data',
    'Electricity',
    'Generator',
    'Rent',
    'Water',
  ],
  'Work & Growth': [
    'Work Expenses',
    'Courses & Learning',
    'Tools & Software',
    'Equipment',
  ],
  'Health': [
    'Pharmacy',
    'Hospital / Clinic',
    'Personal Care',
  ],
  'Social & Family': [
    'Family Support',
    'Social Events',
    'Church / Mosque',
    'Ajo / Esusu',
  ],
  // Everything in this group except Loan Repayment and Bank Charges is money
  // moving between your own pockets rather than being earned or spent. Anything
  // added here that is a transfer must also go in TRANSFER_CATEGORIES
  // (src/lib/summary.js) or it starts counting as income or spending.
  'Financial': [
    'Loan Repayment',
    'Bank Charges',
    'Savings Transfer',
    'Savings',
    'Investment',
    'Cash Withdrawal',
    'Cash Received',
  ],
  'Personal': [
    'Clothing & Fashion',
    'Entertainment',
    'Dining Out',
    'Subscriptions',
  ],
  'Other': [
    'Repairs',
    'Miscellaneous',
    'Uncategorized',
  ],
}

export const CATEGORY_ICONS = {
  'Feeding / Groceries': '🛒',
  'Transport': '🚗',
  'Airtime & Data': '📱',
  'Electricity': '⚡',
  'Generator': '⛽',
  'Rent': '🏠',
  'Water': '💧',
  'Work Expenses': '💼',
  'Courses & Learning': '📚',
  'Tools & Software': '💻',
  'Equipment': '🛠️',
  'Pharmacy': '💊',
  'Hospital / Clinic': '🏥',
  'Personal Care': '🧴',
  'Family Support': '👨👩👧👦',
  'Social Events': '🎉',
  'Church / Mosque': '🙏',
  'Ajo / Esusu': '🤝',
  'Loan Repayment': '💳',
  'Bank Charges': '🏦',
  'Savings Transfer': '🐖',
  'Savings': '🐖',
  'Investment': '📈',
  'Cash Withdrawal': '🏧',
  'Cash Received': '💵',
  'Clothing & Fashion': '👕',
  'Entertainment': '🎬',
  'Dining Out': '🍽️',
  'Subscriptions': '🔄',
  'Repairs': '🔧',
  'Miscellaneous': '📦',
  'Uncategorized': '❓',
}

export const ALL_CATEGORIES = Object.values(CATEGORIES).flat()

export function getCategoryIcon(category) {
  return CATEGORY_ICONS[category] || '📦'
}
