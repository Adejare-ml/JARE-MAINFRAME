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
  'Financial': [
    'Loan Repayment',
    'Bank Charges',
    'Savings Transfer',
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

// Flat array of all categories
export const ALL_CATEGORIES = Object.values(CATEGORIES).flat()
