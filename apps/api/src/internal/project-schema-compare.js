function normalizeDataType(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().toLowerCase();
}

function normalizeOptions(options) {
  if (!Array.isArray(options)) {
    return [];
  }
  return options.filter((option) => typeof option === "string");
}

function equalStringArrays(left, right) {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}

export function compareProjectSchema(requiredSchema, liveSchema) {
  const mismatches = [];
  const requiredFields = Array.isArray(requiredSchema?.required_fields) ? requiredSchema.required_fields : [];
  const liveFields = Array.isArray(liveSchema?.fields) ? liveSchema.fields : [];

  for (const requiredField of requiredFields) {
    const fieldName = requiredField?.name;
    if (typeof fieldName !== "string" || fieldName.length === 0) {
      continue;
    }

    const expectedType = normalizeDataType(requiredField?.type);
    const expectedOptions =
      expectedType === "single_select" ? normalizeOptions(requiredField?.allowed_options) : undefined;

    const liveField = liveFields.find((field) => field?.name === fieldName);
    if (!liveField) {
      mismatches.push({
        field: fieldName,
        kind: "missing_field",
        expected: {
          type: expectedType,
          ...(expectedOptions ? { options: expectedOptions } : {}),
        },
      });
      continue;
    }

    const actualType = normalizeDataType(liveField?.type);
    const actualOptions = actualType === "single_select" ? normalizeOptions(liveField?.options) : undefined;

    if (actualType !== expectedType) {
      mismatches.push({
        field: fieldName,
        kind: "wrong_type",
        expected: {
          type: expectedType,
          ...(expectedOptions ? { options: expectedOptions } : {}),
        },
        actual: {
          type: actualType,
          ...(actualOptions ? { options: actualOptions } : {}),
        },
      });
      continue;
    }

    if (expectedType === "single_select") {
      const normalizedExpectedOptions = expectedOptions ?? [];
      const normalizedActualOptions = actualOptions ?? [];

      if (!equalStringArrays(normalizedExpectedOptions, normalizedActualOptions)) {
        mismatches.push({
          field: fieldName,
          kind: "options_mismatch",
          expected: {
            type: expectedType,
            options: normalizedExpectedOptions,
          },
          actual: {
            type: actualType,
            options: normalizedActualOptions,
          },
        });
      }
    }
  }

  return {
    status: mismatches.length === 0 ? "PASS" : "FAIL",
    mismatches,
  };
}
