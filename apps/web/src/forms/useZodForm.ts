import { useCallback, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import type { z } from 'zod';

export type FieldErrors = Record<string, string>;

/**
 * A tiny resolver from a shared zod schema to `{ field: firstArabicMessage }`.
 * (We don't depend on @mantine/form; the schemas in @nuzli/shared are the single source.)
 */
export function zodResolver<S extends z.ZodTypeAny>(schema: S) {
  return (values: unknown): { data?: z.output<S>; errors: FieldErrors } => {
    const r = schema.safeParse(values);
    if (r.success) return { data: r.data, errors: {} };
    const errors: FieldErrors = {};
    for (const issue of r.error.issues) {
      const key = issue.path.join('.') || '_form';
      if (!errors[key]) errors[key] = issue.message;
    }
    return { errors };
  };
}

type Values = Record<string, unknown>;

/**
 * Minimal form state for Mantine inputs: values, inline Arabic errors (from the schema on
 * submit and on blur after the first submit), and server field errors via `setErrors`.
 */
export function useZodForm<S extends z.ZodTypeAny, V extends Values>(schema: S, initialValues: V) {
  const [values, setValues] = useState<V>(initialValues);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const submitted = useRef(false);
  const resolve = useRef(zodResolver(schema)).current;

  const valuesRef = useRef(values);
  valuesRef.current = values;

  const setFieldValue = useCallback(
    <K extends keyof V>(name: K, value: V[K]) => {
      const next = { ...valuesRef.current, [name]: value };
      valuesRef.current = next;
      setValues(next);
      const key = name as string;
      const fieldError = submitted.current ? resolve(next).errors[key] : undefined;
      setErrors((e) => {
        if (fieldError === e[key]) return e;
        const copy = { ...e };
        if (fieldError) copy[key] = fieldError;
        else delete copy[key];
        return copy;
      });
    },
    [resolve],
  );

  /** Props for TextInput / PasswordInput / Textarea / Select / NumberInput / SegmentedControl. */
  const getInputProps = <K extends keyof V & string>(name: K) => ({
    value: values[name] as never,
    error: errors[name],
    onChange: (arg: unknown) => {
      const v =
        arg && typeof arg === 'object' && 'currentTarget' in (arg as object)
          ? (arg as ChangeEvent<HTMLInputElement>).currentTarget.value
          : arg;
      setFieldValue(name, v as V[K]);
    },
  });

  /** Props for Checkbox / Switch. */
  const getCheckboxProps = <K extends keyof V & string>(name: K) => ({
    checked: Boolean(values[name]),
    error: errors[name],
    onChange: (e: ChangeEvent<HTMLInputElement>) =>
      setFieldValue(name, e.currentTarget.checked as V[K]),
  });

  const onSubmit =
    (handler: (data: z.output<S>) => Promise<unknown> | unknown) => async (event?: FormEvent) => {
      event?.preventDefault();
      submitted.current = true;
      const { data, errors: errs } = resolve(values);
      setErrors(errs);
      if (data === undefined) return;
      setSubmitting(true);
      try {
        await handler(data);
      } finally {
        setSubmitting(false);
      }
    };

  const reset = (next?: V) => {
    submitted.current = false;
    setValues(next ?? initialValues);
    setErrors({});
  };

  return {
    values,
    errors,
    setErrors,
    setValues,
    setFieldValue,
    getInputProps,
    getCheckboxProps,
    onSubmit,
    submitting,
    reset,
  };
}
