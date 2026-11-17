// Type declarations of the public API, written by hand from doc/spec-client.md and
// doc/spec-server.md; they declare nothing the spec does not define.
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';

/** A range in Modicon notation, `"<address>[,<length>]"`, 5 or 6 digits, e.g. `"40001,2"`. */
export type Modicon_Range = string;

/** A structured PDU range; `pdu_addr` is the 0-based address on the wire. */
export type Pdu_Range =
	| readonly [func_code: number, pdu_addr: number, length: number]
	| { readonly func_code: number; readonly pdu_addr: number; readonly length: number };

export type Modbus_Range = Modicon_Range | Pdu_Range;

/** Serial parity: `0` = none, `1` = odd, `2` = even. */
export type Parity = 'none' | 'odd' | 'even' | 0 | 1 | 2;

export interface Serial_Options {
	/** Serial baud rate. Default `9600`. */
	baud_rate?: number;
	/** Default `'none'`. */
	parity?: Parity;
	/** Default `8`. */
	data_bits?: 5 | 6 | 7 | 8;
	/** Default `1`. */
	stop_bits?: 1 | 1.5 | 2;
}

// Every key of `All` that `T` lacks, made unusable: one transport option, and only the options
// that apply to it
type Exclusive<T, All> = T & { [K in Exclude<keyof All, keyof T>]?: never };

// ---------------------------------------------------------------------------------------------
// Modbus_Client

interface Client_Common_Options {
	/** A name for telling instances apart, e.g. in logs. Default `'Modbus_Client'`. */
	name?: string;
	/** Per-transaction response timeout, ms. Default `1000`. */
	timeout?: number;
	/** Minimum gap before the next frame write, ms. Default `20`. */
	delay?: number;
	/** Initial reconnect delay, ms; `> 0` also connects at construction. Default `10000`. */
	reconnect_time?: number;
	/** `true` selects 0-based Modicon point numbering. Default `false`. */
	modicon_zero_based?: boolean;
}

interface Client_Tcp_Family_Options {
	/** Upper bound of the growing reconnect delay, ms. Default `60000`. */
	reconnect_max?: number;
	/** Consecutive timeouts after which the connection is closed as dead; `0` disables. Default `3`. */
	max_timeouts?: number;
	/** Idle time before the first TCP keep-alive probe, ms; `0` disables. Default `10000`. */
	keep_alive?: number;
	/** Silence after which the bytes left of an incomplete frame are resolved, ms. Default `50`. */
	silence?: number;
}

interface Client_Udp_Family_Options {
	/** Upper bound of the growing reconnect delay, ms. Default `60000`. */
	reconnect_max?: number;
	/** The local `host:port` the socket binds; the host may be empty. */
	local?: string;
	/** Accept a datagram from the server's address whatever its source port. Default `false`. */
	any_source_port?: boolean;
}

interface Client_Rtu_Options {
	/** Minimum wait after a broadcast before the next frame write, ms. Default `100`. */
	turnaround?: number;
	/** Silence after which the bytes left of an incomplete frame are resolved, ms. Default `50`. */
	silence?: number;
}

interface Client_Tcp_Options extends Client_Common_Options, Client_Tcp_Family_Options {
	/** Modbus TCP to this `host:port`; the port defaults to `502`. */
	tcp: string;
}

interface Client_Rtu_Over_Tcp_Options extends Client_Common_Options, Client_Tcp_Family_Options, Client_Rtu_Options {
	/** RTU frames on a TCP connection to this `host:port`. */
	rtu_over_tcp: string;
}

interface Client_Udp_Options extends Client_Common_Options, Client_Udp_Family_Options {
	/** Modbus UDP to this `host:port`. */
	udp: string;
}

interface Client_Rtu_Over_Udp_Options extends Client_Common_Options, Client_Udp_Family_Options, Client_Rtu_Options {
	/** RTU frames in UDP datagrams to this `host:port`. */
	rtu_over_udp: string;
}

interface Client_Serial_Options extends Client_Common_Options, Client_Rtu_Options, Serial_Options {
	/** Modbus RTU on this serial device path. */
	serial: string;
}

type Client_All_Options =
	& Client_Tcp_Options & Client_Rtu_Over_Tcp_Options & Client_Udp_Options
	& Client_Rtu_Over_Udp_Options & Client_Serial_Options;

/**
 * Exactly one of `tcp`, `rtu_over_tcp`, `udp`, `rtu_over_udp` and `serial` selects the
 * transport; an option that does not apply to it is not allowed.
 */
export type Modbus_Client_Options =
	| Exclusive<Client_Tcp_Options, Client_All_Options>
	| Exclusive<Client_Rtu_Over_Tcp_Options, Client_All_Options>
	| Exclusive<Client_Udp_Options, Client_All_Options>
	| Exclusive<Client_Rtu_Over_Udp_Options, Client_All_Options>
	| Exclusive<Client_Serial_Options, Client_All_Options>;

export interface Modbus_Client_Events {
	connect: [];
	disconnect: [];
	error: [error: Error | string];
	timeout: [];
	send: [frame: Buffer];
	receive: [frame: Buffer];
	/** A transaction resolved: the payload of a read, or the result of a write. */
	data: [value: Buffer | boolean];
	data_error: [];
}

export class Modbus_Client extends EventEmitter<Modbus_Client_Events> {
	constructor(options: Modbus_Client_Options);

	/** The `name` option. */
	name: string;
	/** Whether Modicon addresses are 0-based. */
	readonly modicon_zero_based: boolean;
	/** Whether the client may open the connection by itself; `false` after `disconnect()`. */
	readonly enable_reconnect: boolean;

	/**
	 * Reads a range of unit `unit_id`. Resolves with the raw payload: big-endian register words,
	 * or coil bits packed LSB first. Throws synchronously on an invalid argument.
	 */
	read(range: Modbus_Range, unit_id?: number): Promise<Buffer>;
	/**
	 * Writes a range of unit `unit_id`: a `boolean` for one coil, an integer `0..65535` (or a
	 * 2-byte `Buffer`) for one register, a `Buffer` for several points. Resolves with whether the
	 * response echoes the request. Throws synchronously on an invalid argument.
	 */
	write(range: Modbus_Range, value: boolean | number | Buffer, unit_id?: number): Promise<boolean>;
	connect(): Promise<void>;
	/** Closes the transport and keeps it closed until the next `connect()`; never rejects. */
	disconnect(): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Modbus_Server

/** A batch read result: exactly `quantity` values, `values[i]` at address `addr + i`. */
export type Batch_Values<T> = ArrayLike<T>;

/**
 * The data-access callbacks of a server, called synchronously with 0-based PDU addresses. A
 * function rejects a request by throwing a value whose `exception_code` is `0x01`, `0x02`,
 * `0x03`, `0x04` or `0x06`, e.g. a `Modbus_Exception`.
 */
export interface Modbus_Handler {
	/** FC 1; FC 2 as well when neither discrete input method is given. Truthy = bit set. */
	get_coil(addr: number, unit_id: number): unknown;
	/** FC 2. Truthy = bit set. */
	get_discrete_input?(addr: number, unit_id: number): unknown;
	/** FC 3: an integer in `0..65535`. */
	get_holding_register(addr: number, unit_id: number): number;
	/** FC 4: an integer in `0..65535`. */
	get_input_register(addr: number, unit_id: number): number;
	/** FC 5, and FC 15 without `set_coils`. */
	set_coil(addr: number, value: boolean, unit_id: number): void;
	/** FC 6, and FC 16 without `set_holding_registers`. */
	set_holding_register(addr: number, value: number, unit_id: number): void;
	/** FC 1 for the whole request; FC 2 as well when neither discrete input method is given. */
	get_coils?(addr: number, quantity: number, unit_id: number): Batch_Values<unknown>;
	/** FC 2 for the whole request. */
	get_discrete_inputs?(addr: number, quantity: number, unit_id: number): Batch_Values<unknown>;
	/** FC 3 for the whole request. */
	get_holding_registers?(addr: number, quantity: number, unit_id: number): Batch_Values<number>;
	/** FC 4 for the whole request. */
	get_input_registers?(addr: number, quantity: number, unit_id: number): Batch_Values<number>;
	/** FC 15 for the whole request. */
	set_coils?(addr: number, values: boolean[], unit_id: number): void;
	/** FC 16 for the whole request. */
	set_holding_registers?(addr: number, values: number[], unit_id: number): void;
}

/** Which unit IDs a server answers: every ID for `null`, `undefined`, `'all'` or `'*'`. */
export type Unit_Ids = number | readonly number[] | 'all' | '*' | null | undefined;

interface Server_Common_Options {
	/** A name for telling instances apart, e.g. in logs. Default `'Modbus_Server'`. */
	name?: string;
	/** Which unit IDs to answer; every ID when omitted. */
	unit_id?: Unit_Ids;
}

interface Server_Silence_Options {
	/** Silence after which the bytes left of an incomplete frame are resolved, ms. Default `50`. */
	silence?: number;
}

interface Server_Tcp_Options extends Server_Common_Options, Server_Silence_Options {
	/** Listen on this `host:port` for Modbus TCP; an empty host binds `0.0.0.0`. */
	tcp: string;
}

interface Server_Rtu_Over_Tcp_Options extends Server_Common_Options, Server_Silence_Options {
	/** Listen on this `host:port` for RTU frames on TCP connections. */
	rtu_over_tcp: string;
}

interface Server_Udp_Options extends Server_Common_Options {
	/** Bind this `host:port` for Modbus UDP; an empty host binds `0.0.0.0`. */
	udp: string;
}

interface Server_Rtu_Over_Udp_Options extends Server_Common_Options, Server_Silence_Options {
	/** Bind this `host:port` for RTU frames in UDP datagrams. */
	rtu_over_udp: string;
}

interface Server_Serial_Options extends Server_Common_Options, Server_Silence_Options, Serial_Options {
	/** Answer as an RTU slave on this serial device path. */
	serial: string;
}

type Server_All_Options =
	& Server_Tcp_Options & Server_Rtu_Over_Tcp_Options & Server_Udp_Options
	& Server_Rtu_Over_Udp_Options & Server_Serial_Options;

/**
 * Exactly one of `tcp`, `rtu_over_tcp`, `udp`, `rtu_over_udp` and `serial` selects the
 * transport; an option that does not apply to it is not allowed.
 */
export type Modbus_Server_Options =
	| Exclusive<Server_Tcp_Options, Server_All_Options>
	| Exclusive<Server_Rtu_Over_Tcp_Options, Server_All_Options>
	| Exclusive<Server_Udp_Options, Server_All_Options>
	| Exclusive<Server_Rtu_Over_Udp_Options, Server_All_Options>
	| Exclusive<Server_Serial_Options, Server_All_Options>;

export interface Modbus_Server_Events {
	start: [];
	stop: [];
	error: [error: Error];
	/** TCP family only. */
	socket_connect: [socket: Socket];
	/** TCP family only. */
	socket_disconnect: [socket: Socket];
	/** TCP family only. */
	socket_error: [error: Error];
	send: [frame: Buffer];
	receive: [frame: Buffer];
	/** A `handler` function failed; the request was answered with exception `0x04`. */
	handler_error: [error: unknown, request: unknown];
}

export class Modbus_Server extends EventEmitter<Modbus_Server_Events> {
	constructor(handler: Modbus_Handler, options: Modbus_Server_Options);

	/** The `name` option. */
	name: string;

	/** Sets which unit IDs to answer; throws on an ID outside `0..255`. */
	set_unit_ids(unit_id: Unit_Ids): void;
	/** Whether the server accepts `unit_id`. */
	is_valid_unit_id(unit_id: number): boolean;
	/** Starts, or restarts, the server; resolves once ready, after the `start` event. */
	start(): Promise<void>;
	/** Stops the server; resolves once closed, after the `stop` event; never rejects. */
	stop(): Promise<void>;
}

/** An `Error` for a `handler` to reject a request with an exception code. */
export class Modbus_Exception extends Error {
	/** Throws a `RangeError` unless `exception_code` is `0x01`, `0x02`, `0x03`, `0x04` or `0x06`. */
	constructor(exception_code: 0x01 | 0x02 | 0x03 | 0x04 | 0x06, message?: string, options?: ErrorOptions);

	readonly name: 'Modbus_Exception';
	readonly exception_code: 0x01 | 0x02 | 0x03 | 0x04 | 0x06;
}
