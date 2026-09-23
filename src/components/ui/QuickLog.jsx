import React, { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { toast } from '../../lib/toast';
import { getCategoryIcon } from '../../lib/constants';
import { groupedCategories } from '../../lib/categories';
import { getCategoryColor } from '../../lib/formatters';
import { toDateOnly } from '../../lib/queries';
import { pendingTransactions } from '../../lib/pendingTransactions';
import { confirmBuzz } from '../../lib/haptics';
import { isMissingFunctionError } from '../../lib/corrections';
import { isValidDate } from '../../lib/sync/normalize';
import { transferCategories, validateTransfer } from '../../lib/transfers';
import Sheet from './Sheet';

// Five steps in every mode. A debit or credit goes amount -> category ->
// wallet -> details -> confirm; a transfer has no category to pick (the pair
// follows from the wallets, see lib/transfers.js), so its middle two steps
// are the wallet it leaves and the wallet it reaches.
const STEPS = {
  AMOUNT: 1,
  CATEGORY: 2,
  WALLET: 3,
  DETAILS: 4,
  CONFIRM: 5,
};

// Module-level opener, same pattern as lib/toast.js. Pages call
// openQuickLog('debit'|'credit'|'transfer') instead of mounting their own
// copy -- the component renders its own floating action button when closed,
// so a second instance would put a second FAB on screen.
//
// `preset.debt` opens the sheet as a repayment of that debt: the category
// and note are filled in, the category step is skipped, and the row is
// written with its debt_id so the Debts page counts it (migration 029).
let openListener = null;

export function openQuickLog(type = 'debit', preset = {}) {
  if (openListener) openListener(type, preset);
}

const MODES = ['debit', 'credit', 'transfer'];

export default function QuickLog() {
  const [isOpen, setIsOpen] = useState(false);
  const [step, setStep] = useState(STEPS.AMOUNT);
  // Idempotency key, minted when the sheet opens. If "Log" is tapped twice, or
  // retried after a dropped connection, the second call hits the unique index
  // on (source, transaction_id) and the whole operation is a no-op -- no
  // duplicate row, no double balance delta. A transfer derives both its legs
  // from this one key.
  const [submissionId, setSubmissionId] = useState(null);

  const [type, setType] = useState('debit'); // 'debit' | 'credit' | 'transfer'
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('');
  const [wallet, setWallet] = useState(null);
  const [toWallet, setToWallet] = useState(null);
  const [note, setNote] = useState('');
  const [wantOrNeed, setWantOrNeed] = useState(''); // 'need', 'want', 'obligation', 'emergency'
  // The debt this entry repays, when opened from the Debts page. Direction
  // follows the debt, so the mode toggle is hidden while it is set.
  const [linkedDebt, setLinkedDebt] = useState(null);
  // Defaults to today; anything earlier is a backdated entry. The RPC has
  // taken a date since 002 -- only the sheet never asked for one.
  const [txDate, setTxDate] = useState(() => toDateOnly(new Date()));

  const [wallets, setWallets] = useState([]);
  const [isLoadingWallets, setIsLoadingWallets] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Briefly true right after a successful write, so the submit button can
  // morph into a checkmark instead of the sheet just vanishing.
  const [justLogged, setJustLogged] = useState(false);

  const isTransfer = type === 'transfer';
  const today = toDateOnly(new Date());

  useEffect(() => {
    if (isOpen) {
      setSubmissionId(crypto.randomUUID());
      fetchWallets();
    } else {
      resetForm();
    }
  }, [isOpen]);

  useEffect(() => {
    openListener = (openType, preset = {}) => {
      setType(MODES.includes(openType) ? openType : 'debit');
      if (preset?.debt?.id) {
        setLinkedDebt(preset.debt);
        setCategory('Loan Repayment');
        setNote(`Repayment -- ${preset.debt.counterparty || ''}`.trim());
      }
      setIsOpen(true);
    };
    return () => {
      openListener = null;
    };
  }, []);

  const fetchWallets = async () => {
    setIsLoadingWallets(true);
    try {
      const { data, error } = await supabase
        .from('wallets')
        .select('id, name, balance, type');

      if (error) throw error;
      setWallets(data || []);
      if (data && data.length > 0 && !wallet) {
        setWallet(data[0]);
      }
    } catch (err) {
      console.error('Error fetching wallets:', err);
      toast.error('Failed to load wallets');
    } finally {
      setIsLoadingWallets(false);
    }
  };

  const resetForm = () => {
    setStep(STEPS.AMOUNT);
    setType('debit');
    setAmount('');
    setCategory('');
    setWallet(null);
    setToWallet(null);
    setNote('');
    setWantOrNeed('');
    setLinkedDebt(null);
    setTxDate(toDateOnly(new Date()));
    setIsSubmitting(false);
    setJustLogged(false);
  };

  // A repayment has its category already, so the sheet steps straight from
  // the amount to the wallet and back again.
  const handleNext = () => setStep((s) => (linkedDebt && s === STEPS.AMOUNT ? STEPS.WALLET : s + 1));
  const handleBack = () => setStep((s) => (linkedDebt && s === STEPS.WALLET ? STEPS.AMOUNT : s - 1));

  /** The date and time the row is stamped with: a clock time only for today,
   *  since a backdated entry has no honest time of day to give. */
  const stampFor = () => {
    const now = new Date();
    // Local date on purpose: the server clock is UTC, so letting it default
    // would file anything logged between midnight and 01:00 Lagos time to
    // yesterday.
    const date = isValidDate(txDate) && txDate <= today ? txDate : toDateOnly(now);
    const time = date === toDateOnly(now) ? now.toTimeString().split(' ')[0] : null;
    return { date, time };
  };

  const finishLogged = (message, color) => {
    confirmBuzz();
    toast.success(message, color ? { color } : undefined);
    // A brief checkmark before the sheet closes, rather than it just
    // vanishing -- long enough to read as a confirmation, short enough to
    // still feel instant.
    setJustLogged(true);
    setTimeout(() => {
      setIsOpen(false);
      setJustLogged(false);
    }, 220);
  };

  const handleSubmit = async () => {
    if (isTransfer) return handleTransfer();

    if (!wallet || !amount || !category) {
      toast.error('Missing required fields');
      return;
    }

    setIsSubmitting(true);

    // Shown in Transactions.jsx the instant this fires, not once the round
    // trip completes. Self-clears on its own after a few seconds even if
    // this function never reaches its finally block, so a dropped connection
    // cannot leave a phantom "syncing" row behind forever -- see
    // lib/pendingTransactions.js.
    pendingTransactions.add({
      id: submissionId,
      type,
      amount: parseFloat(amount) || 0,
      category,
      description: note.trim() || null,
    });

    try {
      const numAmount = parseFloat(amount);
      if (isNaN(numAmount) || numAmount <= 0) {
        throw new Error('Invalid amount');
      }

      const { date, time } = stampFor();

      // One atomic call: insert + balance delta together, idempotent on
      // submissionId. Replaces an insert-then-update pair whose second half
      // failed after the first had committed -- the user was told the log
      // failed while the row existed, and a retry duplicated it.
      const { error } = await supabase.rpc('log_manual_transaction', {
        p_transaction_id: submissionId,
        p_wallet_id: wallet.id,
        p_type: type,
        p_amount: numAmount,
        p_category: category,
        p_note: note.trim() || null,
        p_want_or_need: wantOrNeed || null,
        p_date: date,
        p_time: time,
        // Only named when there is a debt to link: a database behind 029
        // has no p_debt_id, and naming it would make PostgREST reject the
        // call for an ordinary entry too.
        ...(linkedDebt ? { p_debt_id: linkedDebt.id } : {}),
      });

      if (error) {
        if (linkedDebt && isMissingFunctionError(error)) {
          throw new Error('run supabase/migrations/029_debt_link.sql first');
        }
        throw error;
      }

      // The real row is in the database now, and the realtime subscription
      // Transactions.jsx already holds will pick it up -- remove the
      // placeholder immediately rather than leaving both visible until the
      // TTL catches up.
      pendingTransactions.remove(submissionId);
      finishLogged(
        linkedDebt
          ? `₦${numAmount.toLocaleString()} counted toward ${linkedDebt.counterparty} ✓`
          : `₦${numAmount.toLocaleString()} logged ✓`,
        getCategoryColor(category),
      );
    } catch (err) {
      console.error('Error logging transaction:', err);
      toast.error('Failed to log: ' + (err.message || 'check connection and retry'));
      pendingTransactions.remove(submissionId);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleTransfer = async () => {
    const checked = validateTransfer({ from: wallet, to: toWallet, amount });
    if (!checked.ok) {
      toast.error(checked.error);
      return;
    }

    setIsSubmitting(true);
    const numAmount = parseFloat(amount);
    const [debitCategory, creditCategory] = transferCategories(wallet, toWallet);
    const trimmedNote = note.trim() || null;

    pendingTransactions.add({
      id: submissionId,
      type: 'debit',
      amount: numAmount,
      category: debitCategory,
      description: trimmedNote || `To ${toWallet.name}`,
    });

    try {
      const { date, time } = stampFor();

      // Both legs in one call, or neither. Deliberately no two-write fallback
      // when the function is missing: half a transfer is worse than none.
      const { error } = await supabase.rpc('log_wallet_transfer', {
        p_transfer_id: submissionId,
        p_from_wallet: wallet.id,
        p_to_wallet: toWallet.id,
        p_amount: numAmount,
        p_debit_category: debitCategory,
        p_credit_category: creditCategory,
        p_note: trimmedNote,
        p_date: date,
        p_time: time,
      });

      if (error) {
        if (isMissingFunctionError(error)) {
          throw new Error('run supabase/migrations/028_wallet_transfer.sql first');
        }
        throw error;
      }

      pendingTransactions.remove(submissionId);
      finishLogged(`₦${numAmount.toLocaleString()} moved to ${toWallet.name} ✓`);
    } catch (err) {
      console.error('Error logging transfer:', err);
      toast.error('Transfer not logged: ' + (err.message || 'check connection and retry'));
      pendingTransactions.remove(submissionId);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="fixed bottom-20 right-4 lg:bottom-8 lg:right-8 z-40 bg-accent text-black font-extrabold w-14 h-14 rounded-full flex items-center justify-center text-3xl shadow-xl shadow-accent/25 hover:scale-110 active:scale-95 transition-all min-h-[48px] min-w-[48px]"
        aria-label="Quick log"
      >
        +
      </button>
    );
  }

  const renderAmount = () => (
    <div className="flex flex-col h-full space-y-6">
      {linkedDebt ? (
        <div className="flex items-center gap-3 bg-[#0f0f0f] rounded-xl px-4 py-3 border border-white/5">
          <span className="text-xl" aria-hidden="true">🤝</span>
          <div className="min-w-0">
            <p className="text-sm font-bold text-white truncate">
              {type === 'credit' ? 'Repayment from' : 'Repayment to'} {linkedDebt.counterparty}
            </p>
            <p className="text-[11px] text-muted">Counts toward that debt on the Debts page</p>
          </div>
        </div>
      ) : (
      <div className="flex bg-[#0f0f0f] rounded-xl p-1 border border-white/5">
        <button
          className={`flex-1 py-3 text-center rounded-lg text-xs font-bold transition-all min-h-[48px] ${type === 'debit' ? 'bg-red-500/20 text-red-400 border border-red-500/30' : 'text-muted hover:text-white'}`}
          onClick={() => setType('debit')}
        >
          💸 Debit
        </button>
        <button
          className={`flex-1 py-3 text-center rounded-lg text-xs font-bold transition-all min-h-[48px] ${type === 'credit' ? 'bg-accent/20 text-accent border border-accent/30' : 'text-muted hover:text-white'}`}
          onClick={() => setType('credit')}
        >
          💰 Credit
        </button>
        <button
          className={`flex-1 py-3 text-center rounded-lg text-xs font-bold transition-all min-h-[48px] ${type === 'transfer' ? 'bg-teal-500/20 text-teal-300 border border-teal-500/30' : 'text-muted hover:text-white'}`}
          onClick={() => setType('transfer')}
        >
          ⇄ Transfer
        </button>
      </div>
      )}

      <div className="flex-1 flex flex-col items-center justify-center py-6">
        <label className="text-xs text-muted font-semibold uppercase tracking-wider mb-2">
          {isTransfer ? 'Amount to move' : 'Enter Amount'}
        </label>
        <div className="flex items-center text-4xl md:text-5xl font-extrabold text-white">
          <span className="text-accent mr-1">₦</span>
          <input
            type="number"
            inputMode="decimal"
            autoFocus
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="bg-transparent border-none outline-none w-full text-center placeholder-hint focus:ring-0"
            placeholder="0"
          />
        </div>
      </div>

      <div className="flex space-x-3 pt-4">
        <button
          onClick={() => setAmount('')}
          className="flex-1 bg-white/5 text-muted hover:text-white rounded-xl font-bold text-sm min-h-[48px] transition-colors"
        >
          Clear
        </button>
        <button
          onClick={handleNext}
          disabled={!amount || parseFloat(amount) <= 0}
          className="flex-1 bg-accent text-black rounded-xl font-bold text-sm min-h-[48px] disabled:opacity-50 hover:bg-accent/90 transition-colors"
        >
          Next →
        </button>
      </div>
    </div>
  );

  const renderCategory = () => (
    <div className="flex flex-col h-full space-y-4">
      <p className="text-xs font-semibold text-muted uppercase tracking-wider">Select Category</p>

      <div className="flex-1 overflow-y-auto pr-1 pb-16 space-y-4 max-h-[50vh]">
        {Object.entries(groupedCategories()).map(([section, cats]) => (
          <div key={section} className="space-y-2">
            <h4 className="text-[11px] font-bold text-muted-dim uppercase tracking-widest">{section}</h4>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {cats.map(cat => {
                const icon = getCategoryIcon(cat);
                const isSelected = category === cat;
                return (
                  <button
                    key={cat}
                    onClick={() => {
                      setCategory(cat);
                      setStep(STEPS.WALLET);
                    }}
                    className={`flex items-center gap-2 p-3 rounded-xl border text-left text-xs font-medium transition-all min-h-[48px] ${
                      isSelected ? 'bg-accent/20 border-accent text-white font-bold' : 'bg-white/5 border-white/5 text-muted hover:text-white hover:bg-white/10'
                    }`}
                  >
                    <span className="text-lg">{icon}</span>
                    <span className="truncate">{cat}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="pt-2">
        <button
          onClick={handleNext}
          disabled={!category}
          className="w-full bg-accent text-black rounded-xl font-bold text-sm min-h-[48px] disabled:opacity-50 hover:bg-accent/90 transition-colors"
        >
          Next →
        </button>
      </div>
    </div>
  );

  const walletIcon = (w) => (w.type === 'bank' ? '🏦' : w.type === 'mobile' ? '📱' : w.type === 'savings' ? '🐖' : w.type === 'investment' ? '📈' : '💵');

  /**
   * One wallet list for three uses: the wallet a debit or credit touches,
   * the wallet a transfer leaves, and the wallet it reaches (which cannot
   * be the one it left).
   */
  const renderWalletPicker = ({ label, selected, onSelect, exclude, disabledNext }) => (
    <div className="flex flex-col h-full space-y-4">
      <p className="text-xs font-semibold text-muted uppercase tracking-wider">{label}</p>

      {isLoadingWallets ? (
        <div className="flex-1 flex justify-center items-center">
          <span className="animate-spin text-2xl">⌛</span>
        </div>
      ) : (
        <div className="flex-1 space-y-2">
          {wallets.filter((w) => w.id !== exclude?.id).map(w => {
            const isSelected = selected?.id === w.id;
            return (
              <button
                key={w.id}
                onClick={() => onSelect(w)}
                className={`w-full flex items-center justify-between p-4 rounded-2xl border transition-all min-h-[56px] ${
                  isSelected ? 'bg-accent/20 border-accent text-white' : 'bg-white/5 border-white/5 text-muted hover:text-white'
                }`}
              >
                <div className="flex items-center gap-3">
                  <span className="text-2xl">{walletIcon(w)}</span>
                  <div className="text-left">
                    <p className="font-bold text-white text-sm">{w.name}</p>
                    <p className="text-xs text-muted capitalize">{w.type}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-bold text-sm text-white">
                    ₦{parseFloat(w.balance || 0).toLocaleString(undefined, {minimumFractionDigits: 2})}
                  </span>
                  {isSelected && <span className="text-accent text-lg font-bold">✓</span>}
                </div>
              </button>
            );
          })}
          {wallets.length <= 1 && isTransfer && (
            <p className="text-[11px] text-muted-dim">A transfer needs two wallets. Add another in Settings → Banks & Wallets.</p>
          )}
        </div>
      )}

      <div className="pt-2 mt-auto">
        <button
          onClick={handleNext}
          disabled={disabledNext}
          className="w-full bg-accent text-black rounded-xl font-bold text-sm min-h-[48px] disabled:opacity-50 hover:bg-accent/90 transition-colors"
        >
          Next →
        </button>
      </div>
    </div>
  );

  const renderDetails = () => (
    <div className="flex flex-col h-full space-y-4">
      <p className="text-xs font-semibold text-muted uppercase tracking-wider">Details (Optional)</p>

      <div className="space-y-4 flex-1">
        <div>
          <label className="block text-xs font-medium text-muted mb-1">Note</label>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={isTransfer ? 'why the move?' : 'what was this for?'}
            className="w-full px-4 py-3 bg-background border border-white/10 rounded-xl text-white text-sm placeholder-hint focus:outline-none focus:border-accent min-h-[48px]"
          />
        </div>

        <div>
          <label htmlFor="quicklog-date" className="block text-xs font-medium text-muted mb-1">Date</label>
          <input
            id="quicklog-date"
            type="date"
            value={txDate}
            max={today}
            onChange={(e) => setTxDate(e.target.value)}
            className="w-full px-4 py-3 bg-background border border-white/10 rounded-xl text-white text-sm focus:outline-none focus:border-accent min-h-[48px]"
          />
          {txDate !== today && (
            <p className="text-[11px] text-muted-dim mt-1">Backdated -- it will sit in that day's totals, not today's.</p>
          )}
        </div>

        {!isTransfer && (
          <div>
            <label className="block text-xs font-medium text-muted mb-1">Tag (Classification)</label>
            <div className="grid grid-cols-2 gap-2">
              {['need', 'want', 'obligation', 'emergency'].map(tag => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => setWantOrNeed(wantOrNeed === tag ? '' : tag)}
                  className={`py-3 px-3 rounded-xl border text-xs font-bold uppercase tracking-wider transition-all min-h-[48px] ${
                    wantOrNeed === tag ? 'bg-accent/20 border-accent text-accent' : 'bg-white/5 border-white/5 text-muted hover:text-white'
                  }`}
                >
                  {tag}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="pt-2 mt-auto">
        <button
          onClick={handleNext}
          disabled={!isValidDate(txDate) || txDate > today}
          className="w-full bg-accent text-black rounded-xl font-bold text-sm min-h-[48px] hover:bg-accent/90 transition-colors disabled:opacity-50"
        >
          {note || wantOrNeed || txDate !== today ? 'Next → Summary' : 'Skip & Next →'}
        </button>
      </div>
    </div>
  );

  const renderConfirm = () => {
    const [debitCategory, creditCategory] = isTransfer ? transferCategories(wallet, toWallet) : [];
    return (
      <div className="flex flex-col h-full space-y-6">
        <p className="text-xs font-semibold text-muted uppercase tracking-wider">
          {isTransfer ? 'Confirm Transfer' : 'Confirm Transaction'}
        </p>

        <div className="bg-background border border-white/10 rounded-2xl p-5 space-y-3">
          <div className="flex items-center justify-between border-b border-white/5 pb-3">
            <span className="text-muted text-xs">Amount</span>
            <span className={`text-2xl font-extrabold ${type === 'credit' ? 'text-accent' : isTransfer ? 'text-teal-300' : 'text-white'}`}>
              {type === 'credit' ? '+' : isTransfer ? '⇄ ' : '-'}₦{parseFloat(amount || 0).toLocaleString()}
            </span>
          </div>
          {isTransfer ? (
            <>
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted">From</span>
                <span className="text-white font-bold">{wallet?.name}</span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted">To</span>
                <span className="text-white font-bold">{toWallet?.name}</span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted">Filed as</span>
                <span className="text-white font-medium">
                  {getCategoryIcon(debitCategory)} {debitCategory} → {getCategoryIcon(creditCategory)} {creditCategory}
                </span>
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted">Type</span>
                <span className="text-white font-bold capitalize">{type}</span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted">Category</span>
                <span className="text-white font-bold flex items-center gap-1">
                  <span>{getCategoryIcon(category)}</span>
                  <span>{category}</span>
                </span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted">Wallet</span>
                <span className="text-white font-bold">{wallet?.name}</span>
              </div>
              {linkedDebt && (
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted">Counts toward</span>
                  <span className="text-white font-bold">🤝 {linkedDebt.counterparty}</span>
                </div>
              )}
            </>
          )}
          {txDate !== today && (
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted">Date</span>
              <span className="text-white font-bold">{txDate}</span>
            </div>
          )}
          {note && (
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted">Note</span>
              <span className="text-white font-medium truncate max-w-[180px]">{note}</span>
            </div>
          )}
          {!isTransfer && wantOrNeed && (
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted">Tag</span>
              <span className="text-accent uppercase font-bold text-[10px]">{wantOrNeed}</span>
            </div>
          )}
        </div>

        <div className="pt-2 mt-auto">
          <button
            onClick={handleSubmit}
            disabled={isSubmitting || justLogged}
            className="w-full bg-accent text-black rounded-xl font-extrabold text-base py-4 hover:bg-accent/90 transition-all shadow-lg shadow-accent/20 disabled:opacity-50 min-h-[48px] flex items-center justify-center gap-2"
          >
            {justLogged ? (
              <span className="inline-block text-xl animate-check-pop" aria-hidden="true">✓</span>
            ) : isSubmitting ? (
              <span className="inline-block w-5 h-5 border-2 border-black border-t-transparent rounded-full animate-spin" />
            ) : isTransfer ? (
              'Move It ✓'
            ) : (
              'Log It ✓'
            )}
          </button>
        </div>
      </div>
    );
  };

  const renderStep = () => {
    if (step === STEPS.AMOUNT) return renderAmount();
    if (step === STEPS.DETAILS) return renderDetails();
    if (step === STEPS.CONFIRM) return renderConfirm();
    if (isTransfer) {
      return step === STEPS.CATEGORY
        ? renderWalletPicker({ label: 'From which wallet', selected: wallet, onSelect: setWallet, disabledNext: !wallet })
        : renderWalletPicker({ label: 'To which wallet', selected: toWallet, onSelect: setToWallet, exclude: wallet, disabledNext: !toWallet || toWallet.id === wallet?.id });
    }
    return step === STEPS.CATEGORY
      ? renderCategory()
      : renderWalletPicker({ label: 'Select Wallet', selected: wallet, onSelect: setWallet, disabledNext: !wallet });
  };

  return (
    <Sheet isOpen={isOpen} onClose={() => setIsOpen(false)} title={isTransfer ? 'Move money between wallets' : 'Log a transaction'}>
      <>
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-white/5 bg-card">
            {step > STEPS.AMOUNT ? (
              <button
                onClick={handleBack}
                className="text-muted hover:text-white font-bold text-sm min-h-[48px] min-w-[48px] flex items-center"
              >
                ← Back
              </button>
            ) : (
              <div className="w-12" />
            )}

            <div className="flex space-x-1.5">
              {(linkedDebt ? [1, 3, 4, 5] : [1, 2, 3, 4, 5]).map(s => (
                <div
                  key={s}
                  className={`h-1.5 rounded-full transition-all ${s === step ? 'w-6 bg-accent' : 'w-1.5 bg-white/20'}`}
                />
              ))}
            </div>

            <button
              onClick={() => setIsOpen(false)}
              className="w-9 h-9 rounded-full bg-white/5 hover:bg-white/10 text-muted hover:text-white flex items-center justify-center font-bold text-sm min-h-[48px] min-w-[48px]"
            >
              ✕
            </button>
          </div>

          {/* Body */}
          <div className="p-6 flex-1 overflow-y-auto">
            {renderStep()}
          </div>
      </>
    </Sheet>
  );
}
