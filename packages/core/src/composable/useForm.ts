import {
  computed,
  reactive,
  ref,
  onMounted,
  provide,
  readonly,
  Ref,
  UnwrapNestedRefs,
} from 'vue';
import isEqual from 'fast-deep-equal/es6';
import { klona as deepClone } from 'klona/full';
import deepmerge from 'deepmerge';

import { FormContextKey } from './useFormContext';
import isPromise from '../utils/isPromise';
import keysOf from '../utils/keysOf';
import isFunction from '../utils/isFunction';
import get from '../utils/get';
import set from '../utils/set';

import useFormStore from './useFormStore';
import isString from '../utils/isString';

import type { Reducer } from './useFormStore';
import type { FormValues, FieldValidator, Path, PathValue } from '../types';

export type FormikTouched<Values> = {
  [K in keyof Values]?: Values[K] extends any[]
    ? Values[K][number] extends object
      ? FormikTouched<Values[K][number]>[]
      : boolean
    : Values[K] extends object
    ? FormikTouched<Values[K]>
    : boolean;
};

export type FormErrors<Values> = {
  [K in keyof Values]?: Values[K] extends any[]
    ? Values[K][number] extends object
      ? FormErrors<Values[K][number]>[] | string | string[]
      : string | string[]
    : Values[K] extends object
    ? FormErrors<Values[K]>
    : string;
};

interface FieldRegistry {
  [field: string]: {
    validate: (value: any) => string | Promise<string> | boolean | undefined;
  };
}

interface FieldArrayRefistry {
  [field: string]: {
    reset: () => void;
  };
}

interface FieldRegisterOptions<Values> {
  validate?: FieldValidator<Values>;
}

export interface FormState<Values extends FormValues> {
  values: UnwrapNestedRefs<Values>;
  touched: Ref<FormikTouched<Values>>;
  errors: Ref<FormErrors<Values>>;
  submitCount: Ref<number>;
  isSubmitting: Ref<boolean>;
}

export interface FormResetState<Values extends FormValues = FormValues> {
  values: Values;
  touched: FormikTouched<Values>;
  errors: FormErrors<Values>;
}

export interface FormSubmitHelper {
  setSubmitting: (isSubmitting: boolean) => void;
}

export interface FormEventHandler {
  handleBlur: {
    (event: Event, name?: string): void;
    <T = string | Event>(name: T): T extends string ? () => void : void;
  };

  handleChange: () => void;
}

export type ValidateMode = 'blur' | 'change' | 'submit';

export interface UseFormOptions<Values extends FormValues> {
  initialValues: Values;
  validateMode?: ValidateMode;
  reValidateMode?: ValidateMode;
  validateOnMounted?: boolean;
  onSubmit: (values: Values, helper: FormSubmitHelper) => void | Promise<any>;
  onError?: (errors: FormErrors<Values>) => void;
  validate?: (valuse: Values) => void | object | Promise<FormErrors<Values>>;
}

const enum ACTION_TYPE {
  SUBMIT_ATTEMPT,
  SUBMIT_SUCCESS,
  SUBMIT_FAILURE,
  SET_FIELD_VALUE,
  SET_TOUCHED,
  SET_ERRORS,
  SET_ISSUBMITTING,
  RESET_FORM,
}

type FormMessage<Values extends FormValues> =
  | { type: ACTION_TYPE.SUBMIT_ATTEMPT }
  | { type: ACTION_TYPE.SUBMIT_SUCCESS }
  | { type: ACTION_TYPE.SUBMIT_FAILURE }
  | { type: ACTION_TYPE.SET_FIELD_VALUE; payload: { path: string; value: any } }
  | {
      type: ACTION_TYPE.SET_TOUCHED;
      payload: { path: string; touched?: boolean };
    }
  | { type: ACTION_TYPE.SET_ERRORS; payload: FormErrors<Values> }
  | { type: ACTION_TYPE.SET_ISSUBMITTING; payload: boolean }
  | { type: ACTION_TYPE.RESET_FORM; payload: FormResetState<Values> };

function reducer<Values extends FormValues>(
  state: FormState<Values>,
  message: FormMessage<Values>,
) {
  switch (message.type) {
    case ACTION_TYPE.SUBMIT_ATTEMPT:
      state.isSubmitting.value = true;
      state.submitCount.value = state.submitCount.value + 1;
      return;
    case ACTION_TYPE.SUBMIT_SUCCESS:
      state.isSubmitting.value = false;
      return;
    case ACTION_TYPE.SUBMIT_FAILURE:
      state.isSubmitting.value = false;
      return;
    case ACTION_TYPE.SET_FIELD_VALUE:
      set(state.values, message.payload.path, message.payload.value);
      return;
    case ACTION_TYPE.SET_TOUCHED:
      set(state.touched.value, message.payload.path, message.payload.touched);
      return;
    case ACTION_TYPE.SET_ERRORS:
      state.errors.value = message.payload;
      return;
    case ACTION_TYPE.SET_ISSUBMITTING:
      state.isSubmitting.value = message.payload;
      return;
    case ACTION_TYPE.RESET_FORM:
      keysOf(state.values).forEach((key) => {
        delete state.values[key];
      });

      keysOf(message.payload.values).forEach((path) => {
        (state.values as Values)[path] = message.payload.values[path];
      });

      state.touched.value = message.payload.touched;
      state.errors.value = message.payload.errors;
  }
}

export function useForm<Values extends FormValues = FormValues>({
  validateOnMounted = false,
  validateMode = 'submit',
  reValidateMode = 'change',
  onSubmit,
  onError,
  ...options
}: UseFormOptions<Values>) {
  const [state, dispatch] = useFormStore<
    Reducer<FormState<Values>, FormMessage<Values>>
  >(reducer, {
    values: reactive(deepClone(options.initialValues)),
    errors: ref({}) as Ref<FormErrors<Values>>,
    touched: ref({}),
    submitCount: ref(0),
    isSubmitting: ref(false),
  });

  let initalValues = deepClone(options.initialValues);
  const fieldRegistry: FieldRegistry = {};
  const fieldArrayRegistry: FieldArrayRefistry = {};

  const dirty = computed(() => !isEqual(state.values, initalValues));
  const validateTiming = computed(() =>
    state.submitCount.value === 0 ? validateMode : reValidateMode,
  );

  const registerField = (name: string, { validate }: any = {}) => {
    fieldRegistry[name] = {
      validate,
    };
  };

  const registerFieldArray = (name: string, { reset, validate }: any) => {
    fieldRegistry[name] = {
      validate,
    };

    fieldArrayRegistry[name] = {
      reset,
    };
  };

  const setFieldTouched = (name: string, touched = true) => {
    dispatch({
      type: ACTION_TYPE.SET_TOUCHED,
      payload: {
        path: name,
        touched,
      },
    });

    return validateTiming.value === 'blur'
      ? runAllValidateHandler(state.values).then((errors) => {
          dispatch({ type: ACTION_TYPE.SET_ERRORS, payload: errors });
        })
      : Promise.resolve();
  };

  const setFieldValue = (name: string, value: any) => {
    dispatch({
      type: ACTION_TYPE.SET_FIELD_VALUE,
      payload: {
        path: name,
        value,
      },
    });

    return validateTiming.value === 'change'
      ? runAllValidateHandler(state.values).then((errors) => {
          dispatch({ type: ACTION_TYPE.SET_ERRORS, payload: errors });
        })
      : Promise.resolve();
  };

  const handleBlur: FormEventHandler['handleBlur'] = (
    eventOrName: Event | string,
    path?: string,
  ): void | (() => void) => {
    if (isString(eventOrName)) {
      return () => setFieldTouched(eventOrName, true);
    }

    const { name, id } = eventOrName.target as HTMLInputElement;
    const field = path ?? (name || id);

    if (field) {
      setFieldTouched(field, true);
    }
  };

  const handleChange: FormEventHandler['handleChange'] = () => {
    if (validateTiming.value === 'change') {
      runAllValidateHandler(state.values).then((errors) => {
        dispatch({ type: ACTION_TYPE.SET_ERRORS, payload: errors });
      });
    }
  };

  const setSubmitting = (isSubmitting: boolean) => {
    dispatch({ type: ACTION_TYPE.SET_ISSUBMITTING, payload: isSubmitting });
  };

  const getFieldValue = <Value>(name: string) => {
    return computed<Value>({
      get() {
        return get(state.values, name);
      },
      set(value) {
        setFieldValue(name, value);
      },
    });
  };

  const getFieldProps = (name: string) => {
    const value = get(state.values, name);

    const error = computed<string>(() => get(state.errors.value, name));
    const dirty = computed(
      () => !isEqual(get(initalValues, name), value.value),
    );

    return {
      dirty,
      error,
      onBlur: handleBlur(name),
      onChange: handleChange,
    };
  };

  const submitHelper: FormSubmitHelper = {
    setSubmitting,
  };

  const runSingleFieldValidateHandler = (name: string, value: unknown) => {
    return new Promise<string>((resolve) =>
      resolve(fieldRegistry[name].validate(value) as string),
    );
  };

  const runFieldValidateHandler = (values: Values) => {
    const fieldKeysWithValidation = keysOf(fieldRegistry).filter((field) =>
      isFunction(fieldRegistry[field].validate),
    ) as string[];

    const fieldValidatePromisea = fieldKeysWithValidation.map((field) =>
      runSingleFieldValidateHandler(field, get(values, field)),
    );

    return Promise.all(fieldValidatePromisea).then((errors) =>
      errors.reduce((prev, curr, index) => {
        if (curr) {
          set(prev, fieldKeysWithValidation[index], curr);
        }
        return prev;
      }, {} as FormErrors<Values>),
    );
  };

  const runValidateHandler = (valuse: Values) => {
    return new Promise<FormErrors<Values>>((resolve) => {
      const maybePromise = options.validate?.(valuse);
      if (maybePromise == null) {
        resolve({});
      } else if (isPromise(maybePromise)) {
        maybePromise.then((error) => {
          resolve(error);
        });
      } else {
        resolve(maybePromise);
      }
    });
  };

  const runAllValidateHandler = (values: Values) => {
    return Promise.all([
      runFieldValidateHandler(values),
      options.validate ? runValidateHandler(values) : {},
    ]).then(([fieldErrors, validateErrors]) => {
      const errors = deepmerge.all<FormErrors<Values>>([
        fieldErrors,
        validateErrors,
      ]);

      return errors;
    });
  };

  const handleSubmit = (event?: Event) => {
    if (event && event.preventDefault) {
      event.preventDefault();
    }

    dispatch({ type: ACTION_TYPE.SUBMIT_ATTEMPT });
    runAllValidateHandler(state.values).then((errors) => {
      const isValid = keysOf(errors).length === 0;
      dispatch({ type: ACTION_TYPE.SET_ERRORS, payload: errors });

      if (isValid) {
        const maybePromise = onSubmit({ ...state.values }, submitHelper);
        if (maybePromise == null) {
          return;
        }

        maybePromise
          .then((result) => {
            dispatch({ type: ACTION_TYPE.SUBMIT_SUCCESS });
            return result;
          })
          .catch((error) => {
            dispatch({ type: ACTION_TYPE.SUBMIT_FAILURE });
            throw error;
          });
      } else {
        dispatch({ type: ACTION_TYPE.SUBMIT_FAILURE });
        onError?.(errors);
      }
    });
  };

  const resetForm = (nextState?: Partial<FormResetState<Values>>) => {
    const values =
      nextState && nextState.values ? nextState.values : initalValues;

    const touched = nextState && nextState.touched ? nextState.touched : {};
    const errors = nextState && nextState.errors ? nextState.errors : {};

    initalValues = deepClone(values);

    dispatch({
      type: ACTION_TYPE.RESET_FORM,
      payload: {
        values,
        touched,
        errors,
      },
    });

    // reset `fields` of `useFieldArray`
    Object.values(fieldArrayRegistry).forEach((field) => {
      field.reset();
    });
  };

  const handleReset = (e?: Event) => {
    if (e && e.preventDefault) {
      e.preventDefault();
    }

    resetForm();
  };

  const register = <Name extends Path<Values>, Value = PathValue<Values, Name>>(
    name: Name,
    options?: FieldRegisterOptions<Value>,
  ) => {
    registerField(name, options);

    return {
      value: getFieldValue<Value>(name),
      ...getFieldProps(name),
    };
  };

  provide(FormContextKey, {
    getFieldProps,
    getFieldValue,
    setFieldValue,
    registerField,
    registerFieldArray,
  });

  onMounted(() => {
    if (!validateOnMounted) return;
    runAllValidateHandler(initalValues).then((errors) => {
      dispatch({ type: ACTION_TYPE.SET_ERRORS, payload: errors });
    });
  });

  const context = {
    values: readonly(state.values),
    touched: computed(() => state.touched.value),
    errors: computed(() => state.errors.value),
    submitCount: computed(() => state.submitCount.value),
    isSubmitting: state.isSubmitting,
    dirty,
    register,
    handleBlur,
    handleChange,
    handleSubmit,
    handleReset,
    resetForm,
  };

  return context;
}
