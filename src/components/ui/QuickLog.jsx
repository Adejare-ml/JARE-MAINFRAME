import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { toast } from '../../lib/toast';
import { groupedCategories } from '../../lib/categories';
import { formatNairaSigned } from '../../lib/formatters';
import { toDateOnly } from '../../lib/queries';
import { pendingTransactions } from '../../lib/pendingTransactions';
import { confirmBuzz } from '../../lib/haptics';
import { isMissingFunctionError } from '../../lib/corrections';
import { isValidDate } from '../../lib/normalize';
import { transferCategories, validateTransfer } from '../../lib/transfers';
import Sheet from './Sheet';
import Button from './Button';
import IconButton from './IconButton';
import Icon from './Icon';
import Label from './Label';
import Money from './Money';
import Segmented from './Segmented';
import CategoryMark from './CategoryMark';
import { Spinner } from './Button';
import { controlClasses } from './Field';

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

  const finishLogged = (message) => {
    confirmBuzz();
    toast.success(message);
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
          ? `Counted ${formatNairaSigned(numAmount)} toward ${linkedDebt.counterparty}`
          : `Logged ${formatNairaSigned(numAmount)} to ${category}`,
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
      finishLogged(`Moved ${formatNairaSigned(numAmount)} to ${toWallet.name}`);
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
        type="button"
        onClick={() => setIsOpen(true)}
        className="press fixed bottom-20 right-4 lg:bottom-8 lg:right-8 z-40 bg-accent text-on-accent w-14 h-14 rounded-full flex items-center justify-center"
        aria-label="Quick log"
      >
        <Icon name="plus" size={26} />
      </button>
    );
  }

  const MODE_OPTIONS = [
    { value: 'debit', label: 'Debit' },
    { value: 'credit', label: 'Credit' },
    { value: 'transfer', label: 'Transfer' },
  ];

  const renderAmount = () => (
    <div className="flex flex-col h-full space-y-5">
      {linkedDebt ? (
        <div className="flex items-center gap-3 bg-surface-2 rounded-control px-3 py-3 border border-border">
          <Icon name="debt" size={20} className="text-muted" />
          <div className="min-w-0">
            <p className="text-heading text-foreground truncate">
              {type === 'credit' ? 'Repayment from' : 'Repayment to'} {linkedDebt.counterparty}
            </p>
            <p className="text-body-sm text-muted">Counts toward that debt on the Debts page</p>
          </div>
        </div>
      ) : (
        <Segmented
          tabs
          full
          idPrefix="quicklog"
          label="Transaction type"
          options={MODE_OPTIONS}
          value={type}
          onChange={setType}
        />
      )}

      <div
        id={`quicklog-panel-${type}`}
        role={linkedDebt ? undefined : 'tabpanel'}
        aria-labelledby={linkedDebt ? undefined : `quicklog-tab-${type}`}
        className="flex-1 flex flex-col items-center justify-center py-6"
      >
        <Label as="label" htmlFor="quicklog-amount" className="mb-2">
          {isTransfer ? 'Amount to move' : 'Amount'}
        </Label>
        <div className="flex items-center text-display text-foreground">
          <span className="text-muted mr-1 font-semibold" aria-hidden="true">₦</span>
          <input
            id="quicklog-amount"
            type="number"
            inputMode="decimal"
            autoFocus
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="bg-transparent border-none outline-none w-full text-center placeholder:text-hint focus:ring-0 tabular-nums"
            placeholder="0"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Button variant="secondary" onClick={() => setAmount('')}>Clear</Button>
        <Button onClick={handleNext} disabled={!amount || parseFloat(amount) <= 0}>Next</Button>
      </div>
    </div>
  );

  const renderCategory = () => (
    <div className="flex flex-col h-full space-y-3">
      <Label as="p">Category</Label>

      <div className="flex-1 overflow-y-auto pr-1 pb-4 space-y-4 max-h-[50vh]">
        {Object.entries(groupedCategories()).map(([section, cats]) => (
          <div key={section} className="space-y-2">
            <Label as="h4" className="block text-muted-dim">{section}</Label>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {cats.map(cat => {
                const isSelected = category === cat;
                return (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => {
                      setCategory(cat);
                      setStep(STEPS.WALLET);
                    }}
                    aria-pressed={isSelected}
                    className={`flex items-center gap-2.5 px-2.5 min-h-12 rounded-control border text-left text-body-sm transition-colors duration-150 ${
                      isSelected ? 'bg-surface-2 border-accent text-foreground font-semibold' : 'bg-card border-border text-foreground hover:bg-surface-2'
                    }`}
                  >
                    <CategoryMark category={cat} />
                    <span className="truncate">{cat}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <Button full onClick={handleNext} disabled={!category}>Next</Button>
    </div>
  );

  const WALLET_GLYPH = { bank: 'bank', mobile: 'phone', savings: 'vault', investment: 'chart', cash: 'cash' };

  /**
   * One wallet list for three uses: the wallet a debit or credit touches,
   * the wallet a transfer leaves, and the wallet it reaches (which cannot
   * be the one it left).
   */
  const renderWalletPicker = ({ label, selected, onSelect, exclude, disabledNext }) => (
    <div className="flex flex-col h-full space-y-3">
      <Label as="p">{label}</Label>

      {isLoadingWallets ? (
        <div className="flex-1 flex justify-center items-center py-8 text-muted">
          <Spinner size={20} />
          <span className="sr-only">Loading wallets</span>
        </div>
      ) : (
        <div className="flex-1 space-y-2">
          {wallets.filter((w) => w.id !== exclude?.id).map(w => {
            const isSelected = selected?.id === w.id;
            return (
              <button
                key={w.id}
                type="button"
                onClick={() => onSelect(w)}
                aria-pressed={isSelected}
                className={`w-full flex items-center justify-between gap-3 px-3 min-h-14 rounded-control border transition-colors duration-150 ${
                  isSelected ? 'bg-surface-2 border-accent' : 'bg-card border-border hover:bg-surface-2'
                }`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span aria-hidden="true" className="inline-flex items-center justify-center w-7 h-7 shrink-0 rounded-chip bg-surface-2 text-muted">
                    <Icon name={WALLET_GLYPH[w.type] || 'budget'} size={16} />
                  </span>
                  <div className="text-left min-w-0">
                    <p className="text-body text-foreground truncate">{w.name}</p>
                    <p className="text-body-sm text-muted capitalize">{w.type}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Money amount={parseFloat(w.balance || 0)} />
                  {isSelected && <Icon name="check" size={18} className="text-accent" />}
                </div>
              </button>
            );
          })}
          {wallets.length <= 1 && isTransfer && (
            <p className="text-body-sm text-muted">A transfer needs two wallets. Add another in Settings, Banks and wallets.</p>
          )}
        </div>
      )}

      <div className="pt-2 mt-auto">
        <Button full onClick={handleNext} disabled={disabledNext}>Next</Button>
      </div>
    </div>
  );

  const renderDetails = () => (
    <div className="flex flex-col h-full space-y-4">
      <Label as="p">Details (optional)</Label>

      <div className="space-y-4 flex-1">
        <div className="space-y-1.5">
          <Label as="label" htmlFor="quicklog-note" className="block">Note</Label>
          <input
            id="quicklog-note"
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={isTransfer ? 'Why the move?' : 'What was this for?'}
            className={controlClasses()}
          />
        </div>

        <div className="space-y-1.5">
          <Label as="label" htmlFor="quicklog-date" className="block">Date</Label>
          <input
            id="quicklog-date"
            type="date"
            value={txDate}
            max={today}
            onChange={(e) => setTxDate(e.target.value)}
            className={controlClasses()}
          />
          {txDate !== today && (
            <p className="text-body-sm text-muted">Backdated: it will sit in that day's totals, not today's.</p>
          )}
        </div>

        {!isTransfer && (
          <div className="space-y-1.5">
            <Label as="p">Tag</Label>
            <div className="grid grid-cols-2 gap-2">
              {['need', 'want', 'obligation', 'emergency'].map(tag => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => setWantOrNeed(wantOrNeed === tag ? '' : tag)}
                  aria-pressed={wantOrNeed === tag}
                  className={`flex items-center justify-center gap-1.5 px-3 min-h-12 rounded-control border text-body-sm capitalize transition-colors duration-150 ${
                    wantOrNeed === tag ? 'bg-surface-2 border-accent text-foreground font-semibold' : 'bg-card border-border text-muted hover:text-foreground'
                  }`}
                >
                  {wantOrNeed === tag && <Icon name="check" size={16} className="text-accent" />}
                  {tag}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="pt-2 mt-auto">
        <Button full onClick={handleNext} disabled={!isValidDate(txDate) || txDate > today}>
          {note || wantOrNeed || txDate !== today ? 'Next: summary' : 'Skip'}
        </Button>
      </div>
    </div>
  );

  const SummaryRow = ({ label, children }) => (
    <div className="flex items-center justify-between gap-3 min-h-10 px-3">
      <span className="text-body-sm text-muted shrink-0">{label}</span>
      <span className="text-body-sm text-foreground font-medium text-right min-w-0 truncate">{children}</span>
    </div>
  );

  const renderConfirm = () => {
    const [debitCategory, creditCategory] = isTransfer ? transferCategories(wallet, toWallet) : [];
    const numeric = parseFloat(amount || 0);
    return (
      <div className="flex flex-col h-full space-y-5">
        <Label as="p">{isTransfer ? 'Confirm transfer' : 'Confirm transaction'}</Label>

        <div className="bg-card border border-border rounded-panel divide-y divide-border">
          <div className="flex items-center justify-between gap-3 px-3 py-3">
            <span className="text-body-sm text-muted">Amount</span>
            <Money
              amount={type === 'debit' && !isTransfer ? -numeric : numeric}
              sign={type === 'credit'}
              tone={type === 'credit' ? 'positive' : 'default'}
              className="text-figure"
            />
          </div>
          {isTransfer ? (
            <>
              <SummaryRow label="From">{wallet?.name}</SummaryRow>
              <SummaryRow label="To">{toWallet?.name}</SummaryRow>
              <SummaryRow label="Filed as">{debitCategory} to {creditCategory}</SummaryRow>
            </>
          ) : (
            <>
              <SummaryRow label="Type"><span className="capitalize">{type}</span></SummaryRow>
              <SummaryRow label="Category">
                <span className="inline-flex items-center gap-2"><CategoryMark category={category} size="sm" />{category}</span>
              </SummaryRow>
              <SummaryRow label="Wallet">{wallet?.name}</SummaryRow>
              {linkedDebt && <SummaryRow label="Counts toward">{linkedDebt.counterparty}</SummaryRow>}
            </>
          )}
          {txDate !== today && <SummaryRow label="Date">{txDate}</SummaryRow>}
          {note && <SummaryRow label="Note">{note}</SummaryRow>}
          {!isTransfer && wantOrNeed && <SummaryRow label="Tag"><span className="capitalize">{wantOrNeed}</span></SummaryRow>}
        </div>

        <div className="pt-2 mt-auto">
          <Button full onClick={handleSubmit} loading={isSubmitting} disabled={justLogged}>
            {justLogged ? (
              <span className="inline-flex animate-check-pop">
                <Icon name="check" size={20} title="Logged" />
              </span>
            ) : isTransfer ? (
              'Move it'
            ) : (
              'Log it'
            )}
          </Button>
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
      : renderWalletPicker({ label: 'Wallet', selected: wallet, onSelect: setWallet, disabledNext: !wallet });
  };

  const steps = linkedDebt ? [1, 3, 4, 5] : [1, 2, 3, 4, 5];

  return (
    <Sheet isOpen={isOpen} onClose={() => setIsOpen(false)} title={isTransfer ? 'Move money between wallets' : 'Log a transaction'}>
      <>
          <div className="flex items-center justify-between gap-2 px-2 h-12 border-b border-border">
            {step > STEPS.AMOUNT ? (
              <IconButton name="chevL" label="Go back" onClick={handleBack} />
            ) : (
              <div className="w-12" />
            )}

            <span className="type-data text-muted">
              Step {Math.max(1, steps.indexOf(step) + 1)} of {steps.length}
            </span>

            <IconButton name="close" label="Close" onClick={() => setIsOpen(false)} />
          </div>

          <div className="p-4 flex-1 overflow-y-auto">
            {renderStep()}
          </div>
      </>
    </Sheet>
  );
}
