import * as React from "react"
import { Field } from "@base-ui/react/field"

import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <Field.Control
      render={<textarea />}
      data-slot="textarea"
      className={cn("base-textarea", className)}
      {...props as Field.Control.Props}
    />
  )
}

export { Textarea }
