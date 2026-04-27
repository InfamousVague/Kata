import { Icon } from "@base/primitives/icon";
import { smartphone } from "@base/primitives/icon/icons/smartphone";
import "@base/primitives/icon/icon.css";
import "./PhoneToggleButton.css";

interface PhoneToggleButtonProps {
  /// Called when the user clicks the button — the parent should flip
  /// the floating phone modal back open.
  onShow: () => void;
}

/// Small floating round button that brings the FloatingPhone modal
/// back when it's been minimised. Lives in the bottom-right corner
/// just above the AI orb (which sits at right: 20px / bottom: 20px),
/// so the two coexist as a small stack without overlapping.
export default function PhoneToggleButton({ onShow }: PhoneToggleButtonProps) {
  return (
    <button
      type="button"
      className="fishbones-phone-toggle-button"
      onClick={onShow}
      aria-label="Show phone simulator"
      title="Show phone simulator"
    >
      <Icon icon={smartphone} size="sm" color="currentColor" />
    </button>
  );
}
