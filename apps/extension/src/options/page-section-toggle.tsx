import { usePageSectionShown } from "../page-section";

/** Whether the toolbar popup shows its "This page" section; kept on this device only. */
export function PageSectionToggle() {
  const [shown, setShown] = usePageSectionShown();
  return (
    <label className="checkbox-row m-0 text-sm">
      <input
        id="page-section-shown"
        type="checkbox"
        checked={shown}
        onChange={(event) => setShown(event.target.checked)}
      />
      {'Show "This page" in the popup'}
    </label>
  );
}
