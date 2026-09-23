export class UserError extends Error {
  readonly name: string = "UserError";
}

export class ProtocolError extends UserError {
  readonly name = "ProtocolError";
}

export class AdmissionError extends UserError {
  readonly name = "AdmissionError";
}

export class TransportError extends UserError {
  readonly name = "TransportError";
}
