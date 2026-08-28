// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

// D30.3 — EL ACTIVO DE PRUEBA. NO ES UNA STABLECOIN Y NO VALE NADA.
//
// -----------------------------------------------------------------------------
// POR QUE EXISTE
//
// D30 decidio que ningun camino que mueva valor se estrena en mainnet. La
// consecuencia inmediata es que hace falta un activo en Plasma testnet (9746), y
// ahi NO HAY NINGUNO: los faucets dan XPL, que es gas nativo y no tiene
// contrato. El USD-0 de testnet esta "in development" y los deployments
// oficiales de USDT0 no listan ninguna testnet. Verificado por cinco vias,
// incluido un eth_getCode contra la cadena.
//
// Asi que el activo con el que se prueba hay que desplegarlo, y esto es ese
// activo: un ERC-20 con EIP-3009, que es lo unico que el esquema `exact` de x402
// necesita para firmar y liquidar.
//
// -----------------------------------------------------------------------------
// COMO SE LLAMA, Y POR QUE NO SE LLAMA $QVAC
//
// D28 decidio que el riel de pago es stablecoin y que el token nativo vive en la
// capa de incentivos. Como la atestacion de D24 y el recibo de x402 REGISTRAN EL
// ACTIVO, llamar $QVAC a esto escribiria adentro de artefactos firmados la misma
// contradiccion que D28 borro del pitch. Es un stand-in de stablecoin, se llama
// como tal, y va marcado como prueba en los tres lugares donde se ve: el `name`
// que muestra el explorer, el `symbol`, y `AVISO`.
//
// Y el `mint` de abajo es abierto a proposito. No es un descuido: un activo que
// cualquiera puede emitir es la marca mas fuerte posible de que esto NO es una
// stablecoin, y ademas evita custodiar una llave de emision para algo que solo
// existe para que una demo tenga contra que firmar.
//
// -----------------------------------------------------------------------------
// QUE TIENE QUE CUMPLIR, Y QUIEN LO COMPRUEBA
//
// El criterio de aceptacion no se inventa aca: ya estaba escrito y es ejecutable.
//
//     PYRUS_X402_PLASMA_TESTNET_ASSET=0x... \
//     PYRUS_X402_PLASMA_TESTNET_NAME="PyrusLLM Test USD" \
//     npm run verificar-x402
//
// Comprueba tres cosas contra la cadena: que haya contrato, que
// `authorizationState` no revierta (o sea, que implemente EIP-3009), y que el
// DOMAIN_SEPARATOR que devuelve el contrato coincida con el dominio EIP-712 con
// el que vamos a FIRMAR. El tercero es el que mas callado falla y el unico que
// prueba que la firma va a verificar del otro lado.
//
// Hay un cuarto requisito que no sale de x402 sino de este stack: el facilitator
// de `@x402/evm` lee `name()` y `version()` ON-CHAIN antes de liquidar (ver
// `eip3009ABI`). El USD-0 de Plasma REVIERTE en `version()`; aca no, porque no
// hay razon para heredar ese problema en un contrato que escribimos nosotros.
//
// -----------------------------------------------------------------------------
// LAS DOS SOBRECARGAS DE transferWithAuthorization
//
// No es redundancia: `@x402/evm` elige UNA U OTRA por el LARGO DE LA FIRMA
// (`isECDSA = sigLength === 130`). Con 65 bytes llama a la de (v, r, s); con
// cualquier otro largo, a la de `bytes`. Implementar solo una deja media rama
// del facilitator llamando a una funcion que no existe.
//
// LO QUE ESTE CONTRATO **NO** HACE, y conviene que este escrito porque la
// sobrecarga de `bytes` invita a suponer lo contrario: **no soporta ERC-1271**.
// `_recuperar` exige 65 bytes y hace `ecrecover`, asi que un pagador que sea un
// CONTRATO -- wallet inteligente, cuenta con ERC-4337, firma envuelta en
// ERC-6492 -- no puede pagar con este activo. `@x402/evm` si tiene ese camino y
// lo va a intentar; acá revierte.
//
// No es una limitacion que moleste hoy: el pagador de D30 es una EOA de WDK y
// firma 65 bytes. Se declara igual porque un comentario que promete una
// capacidad inexistente es la misma clase de artefacto que este proyecto
// persigue en todos lados -- el que parece prueba y no lo es.

// -----------------------------------------------------------------------------
// POR QUE LOS `require` ESTAN EN INGLES, Y POR QUE NO SE TRADUCEN
//
// Los comentarios de este repo estan en castellano y estos mensajes no. No es un
// descuido y no hay que "arreglarlo": **el revert string es interfaz de maquina
// acá, no texto para una persona.**
//
// `@x402/evm` clasifica un fallo de liquidacion REGEX-MATCHEANDO el mensaje de
// revert (`parseEip3009TransferError`), y esos regex estan escritos contra el
// FiatTokenV2 de Circle, que es la implementacion de referencia de EIP-3009:
//
//     /authorization.*(expired|valid before)/i   -> valid_before_expired
//     /authorization.*not.*valid/i               -> valid_after_in_future
//     /authorization.*used/i                     -> nonce_already_used
//     /transfer.*exceeds.*balance/i              -> insufficient_balance
//     /invalid.*signature/i                      -> invalid_signature
//
// Con los mensajes en castellano NINGUNO matchea y los cinco colapsan a
// `transaction_failed`. Eso hoy casi no molesta -- D9 cobra un tope fijo --, y
// en la Fase 10 rompe algo importante: el lote liquida solo, y esos cinco piden
// tres acciones incompatibles. `nonce_already_used` es un reintento idempotente
// y hay que darlo por cobrado; `insufficient_balance` es del otro lado y no se
// reintenta; `invalid_signature` no es contabilidad, es reputacion. Con un
// unico `transaction_failed` para los tres, el lote no puede decidir.
//
// El prefijo `tUSD:` se mantiene -- identifica al contrato en el explorer y no
// estorba a ningun regex. Hay un test que corre los regex REALES del paquete
// contra estos mensajes: si alguien los traduce, se rompe.

contract PyrusTestUSD {
    // -------------------------------------------------------------------------
    // Lo que se ve en el explorer. Los tres dicen lo mismo.
    // -------------------------------------------------------------------------

    string public constant name = "PyrusLLM Test USD";
    string public constant symbol = "tUSD";

    // El `version` del dominio EIP-712. Se expone como funcion porque el
    // facilitator de @x402/evm la LEE de la cadena antes de liquidar.
    string public constant version = "1";

    string public constant AVISO =
        "ACTIVO DE PRUEBA - NO ES UNA STABLECOIN - NO VALE NADA - mint abierto - PyrusLLM D30.3";

    // 6, como USD-0. No es un detalle estetico: `montoEnUnidades` de
    // qvac/x402.mjs escala micro-dolares por 10^(decimals-6), asi que con 6 un
    // micro-dolar ES una unidad minima y el activo de prueba es intercambiable
    // con el de mainnet para todo lo que el gateway hace.
    uint8 public constant decimals = 6;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    // -------------------------------------------------------------------------
    // EIP-3009
    // -------------------------------------------------------------------------

    // Los typehash se computan con keccak256(bytes(...)) en el constructor y no
    // se pegan como constantes escritas a mano: una constante mal copiada da un
    // contrato que compila, despliega, y rechaza TODAS las firmas -- y el motivo
    // aparece recien contra la cadena.
    bytes32 public immutable TRANSFER_WITH_AUTHORIZATION_TYPEHASH;
    bytes32 public immutable RECEIVE_WITH_AUTHORIZATION_TYPEHASH;
    bytes32 public immutable CANCEL_AUTHORIZATION_TYPEHASH;

    mapping(address => mapping(bytes32 => bool)) private _authorizationStates;

    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);
    event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce);

    // El dominio se ata al chainId. Se guarda el de despliegue y se RECOMPUTA si
    // cambia, que es lo que pasa en un fork: una firma de la cadena vieja no
    // puede valer en la nueva. Es la misma logica que EIP-155 impone a las
    // transacciones, aplicada a las autorizaciones firmadas -- y es exactamente
    // por lo que 9745 y 9746 no se pueden confundir (D30.2).
    uint256 private immutable _chainIdDespliegue;
    bytes32 private immutable _dominioDespliegue;

    constructor() {
        TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
            bytes(
                "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
            )
        );
        RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
            bytes(
                "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
            )
        );
        CANCEL_AUTHORIZATION_TYPEHASH = keccak256(
            bytes("CancelAuthorization(address authorizer,bytes32 nonce)")
        );

        _chainIdDespliegue = block.chainid;
        _dominioDespliegue = _computarDominio(block.chainid);
    }

    function _computarDominio(uint256 chainId) private view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    keccak256(
                        bytes(
                            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                        )
                    ),
                    keccak256(bytes(name)),
                    keccak256(bytes(version)),
                    chainId,
                    address(this)
                )
            );
    }

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return
            block.chainid == _chainIdDespliegue
                ? _dominioDespliegue
                : _computarDominio(block.chainid);
    }

    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool) {
        return _authorizationStates[authorizer][nonce];
    }

    // -------------------------------------------------------------------------
    // ERC-20
    // -------------------------------------------------------------------------

    // MINT ABIERTO. Ver el encabezado: es la marca de que esto no es una
    // stablecoin, y evita custodiar una llave de emision para una demo. El tope
    // por llamada esta para que un loop no genere un totalSupply absurdo que
    // confunda al mirar el explorer, no como control de nada.
    uint256 public constant MINT_MAXIMO_POR_LLAMADA = 1000000000000; // 1.000.000 tUSD

    function mint(address to, uint256 amount) external {
        require(to != address(0), "tUSD: mint to the zero address");
        require(amount <= MINT_MAXIMO_POR_LLAMADA, "tUSD: mint above per-call cap");
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 permitido = allowance[from][msg.sender];
        if (permitido != type(uint256).max) {
            require(permitido >= value, "tUSD: insufficient allowance");
            unchecked {
                allowance[from][msg.sender] = permitido - value;
            }
        }
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) private {
        require(to != address(0), "tUSD: transfer to the zero address");
        uint256 saldo = balanceOf[from];
        require(saldo >= value, "tUSD: transfer amount exceeds balance");
        unchecked {
            balanceOf[from] = saldo - value;
        }
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }

    // -------------------------------------------------------------------------
    // EIP-3009 — las autorizaciones firmadas, que es lo que x402 `exact` usa
    // -------------------------------------------------------------------------

    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external {
        _verificarVentana(validAfter, validBefore);
        _consumir(
            from,
            nonce,
            keccak256(
                abi.encode(
                    TRANSFER_WITH_AUTHORIZATION_TYPEHASH,
                    from,
                    to,
                    value,
                    validAfter,
                    validBefore,
                    nonce
                )
            ),
            signature
        );
        _transfer(from, to, value);
    }

    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        _verificarVentana(validAfter, validBefore);
        _consumir(
            from,
            nonce,
            keccak256(
                abi.encode(
                    TRANSFER_WITH_AUTHORIZATION_TYPEHASH,
                    from,
                    to,
                    value,
                    validAfter,
                    validBefore,
                    nonce
                )
            ),
            abi.encodePacked(r, s, v)
        );
        _transfer(from, to, value);
    }

    // `receiveWithAuthorization` es igual pero exige que el que manda la
    // transaccion sea el destinatario. Existe para que un tercero no pueda
    // adelantarse a presentar la autorizacion; x402 no la usa hoy, y esta porque
    // media EIP-3009 sin ella no es EIP-3009.
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external {
        require(to == msg.sender, "tUSD: caller must be the payee");
        _verificarVentana(validAfter, validBefore);
        _consumir(
            from,
            nonce,
            keccak256(
                abi.encode(
                    RECEIVE_WITH_AUTHORIZATION_TYPEHASH,
                    from,
                    to,
                    value,
                    validAfter,
                    validBefore,
                    nonce
                )
            ),
            signature
        );
        _transfer(from, to, value);
    }

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        require(to == msg.sender, "tUSD: caller must be the payee");
        _verificarVentana(validAfter, validBefore);
        _consumir(
            from,
            nonce,
            keccak256(
                abi.encode(
                    RECEIVE_WITH_AUTHORIZATION_TYPEHASH,
                    from,
                    to,
                    value,
                    validAfter,
                    validBefore,
                    nonce
                )
            ),
            abi.encodePacked(r, s, v)
        );
        _transfer(from, to, value);
    }

    // Cancelar es lo que le da al pagador una salida cuando firmo algo que ya no
    // quiere que se liquide. Sin esto, una autorizacion firmada con un
    // `validBefore` largo no se puede retirar.
    function cancelAuthorization(address authorizer, bytes32 nonce, bytes memory signature)
        external
    {
        require(!_authorizationStates[authorizer][nonce], "tUSD: authorization is used or canceled");
        _verificarFirma(
            authorizer,
            keccak256(abi.encode(CANCEL_AUTHORIZATION_TYPEHASH, authorizer, nonce)),
            signature
        );
        _authorizationStates[authorizer][nonce] = true;
        emit AuthorizationCanceled(authorizer, nonce);
    }

    function cancelAuthorization(address authorizer, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)
        external
    {
        require(!_authorizationStates[authorizer][nonce], "tUSD: authorization is used or canceled");
        _verificarFirma(
            authorizer,
            keccak256(abi.encode(CANCEL_AUTHORIZATION_TYPEHASH, authorizer, nonce)),
            abi.encodePacked(r, s, v)
        );
        _authorizationStates[authorizer][nonce] = true;
        emit AuthorizationCanceled(authorizer, nonce);
    }

    // -------------------------------------------------------------------------

    function _verificarVentana(uint256 validAfter, uint256 validBefore) private view {
        require(block.timestamp > validAfter, "tUSD: authorization is not yet valid");
        require(block.timestamp < validBefore, "tUSD: authorization is expired");
    }

    // EL NONCE ES LA CLAVE DE IDEMPOTENCIA DEL PAGO (D20). Marcarlo ANTES de
    // transferir es lo que hace que un reintento del facilitator no pueda cobrar
    // dos veces: la segunda liquidacion revierte aca, no en nuestro proceso.
    function _consumir(
        address firmante,
        bytes32 nonce,
        bytes32 structHash,
        bytes memory signature
    ) private {
        require(!_authorizationStates[firmante][nonce], "tUSD: authorization is used or canceled");
        _verificarFirma(firmante, structHash, signature);
        _authorizationStates[firmante][nonce] = true;
        emit AuthorizationUsed(firmante, nonce);
    }

    function _verificarFirma(address firmante, bytes32 structHash, bytes memory signature)
        private
        view
    {
        bytes32 digest = keccak256(abi.encodePacked(hex"1901", DOMAIN_SEPARATOR(), structHash));
        require(_recuperar(digest, signature) == firmante, "tUSD: invalid signature");
    }

    // ecrecover con el guardia de maleabilidad. Sin el, (v, r, s) y (v', r, -s)
    // recuperan la misma direccion, o sea que hay DOS firmas validas para la
    // misma autorizacion -- y el nonce solo mata una.
    function _recuperar(bytes32 digest, bytes memory signature) private pure returns (address) {
        require(signature.length == 65, "tUSD: invalid signature length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(signature, 0x20))
            s := mload(add(signature, 0x40))
            v := byte(0, mload(add(signature, 0x60)))
        }
        if (v < 27) v += 27;
        require(
            uint256(s) <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0,
            "tUSD: invalid signature s value"
        );
        require(v == 27 || v == 28, "tUSD: invalid signature v value");
        address recuperado = ecrecover(digest, v, r, s);
        require(recuperado != address(0), "tUSD: invalid signature");
        return recuperado;
    }
}
