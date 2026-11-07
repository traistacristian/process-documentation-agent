import React from 'react';

export default function Consent({ checked, onChange }) {
  return (
    <div className="consent">
      <p style={{ marginTop: 0 }}><b>Before you start.</b> While recording is active, the agent captures the names of the applications and pages you use, the buttons and fields you interact with, messages the applications show, and screenshots of the active screen. It does <b>not</b> capture passwords or the content of sensitive fields, typed text is not stored by default, and applications on the exclusion list are ignored. You can pause or stop at any time, and nothing is published without review and approval. Raw recordings are deleted automatically after the retention period.</p>
      <label><input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} data-testid="consent" /> I understand and want to start recording my activity for this process.</label>
    </div>
  );
}
