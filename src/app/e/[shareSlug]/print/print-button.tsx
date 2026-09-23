"use client";

import { Button } from "@/components/ui";

export function PrintButton() {
  return (
    <Button variant="primary" size="sm" onClick={() => window.print()}>
      Print
    </Button>
  );
}
