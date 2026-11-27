import Sheet from './Sheet'
import CategoryPickerList from './CategoryPickerList'
import IconButton from './IconButton'

/**
 * Icon + label bottom sheet for choosing a category, for a caller with no
 * ancestor Sheet already open -- Transactions' inline row editor and bulk
 * category bar. A caller that already lives inside an open Sheet (GoalForm,
 * CategoryRules) should render CategoryPickerList directly as a swapped-in
 * view instead of this, to avoid two Sheets open at once; see that
 * component's own comment for why.
 *
 * @param {object} props
 * @param {boolean} props.isOpen
 * @param {() => void} props.onClose
 * @param {string} props.value - the currently selected category
 * @param {(category: string) => void} props.onChange
 * @param {string} [props.title]
 * @param {boolean} [props.allowNone]
 * @param {string} [props.noneLabel]
 */
export default function CategoryPickerSheet({
  isOpen,
  onClose,
  value,
  onChange,
  title = 'Select category',
  allowNone = false,
  noneLabel = 'Any category',
}) {
  return (
    <Sheet isOpen={isOpen} onClose={onClose} title={title} desktopCenter>
      <div className="px-4 pb-4 space-y-3 overflow-y-auto">
        <div className="flex items-center justify-between -mr-2">
          <h2 className="text-title text-foreground">{title}</h2>
          <IconButton name="close" label="Close" onClick={onClose} />
        </div>

        <CategoryPickerList
          value={value}
          onSelect={(category) => {
            onChange(category)
            onClose()
          }}
          allowNone={allowNone}
          noneLabel={noneLabel}
        />
      </div>
    </Sheet>
  )
}
