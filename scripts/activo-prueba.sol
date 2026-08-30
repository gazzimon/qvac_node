// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

// D30.3 — THE TEST ASSET. NOT A STABLECOIN AND WORTH NOTHING.
//
// -----------------------------------------------------------------------------
// WHY IT EXISTS
//
// D30 decided no path that moves value gets its first run on mainnet. The
// immediate consequence is that an asset is needed on Plasma testnet (9746),
// and there IS NONE THERE: the faucets give out XPL, which is native gas and
// has no contract. Testnet USD-0 is "in development" and USDT0's official
// deployments list no testnet. Verified five different ways, including an
// eth_getCode against the chain.
//
// So the asset to test with has to be deployed, and this is that asset: an
// ERC-20 with EIP-3009, which is the only thing x402's `exact` scheme needs
// to sign and settle.
//
// -----------------------------------------------------------------------------
// WHAT IT'S CALLED, AND WHY IT ISN'T CALLED $QVAC
//
// D28 decided the payment rail is stablecoin and the native token lives in
// the incentive layer. Since D24's attestation and x402's receipt RECORD THE
// ASSET, calling this $QVAC would write, inside signed artifacts, the exact
// contradiction D28 erased from the pitch. It's a stablecoin stand-in, it's
// named as one, and it's marked as a test in all three places it's visible:
// the `name` the explorer shows, the `symbol`, and `AVISO`.
//
// And the `mint` below is open on purpose. Not an oversight: an asset anyone
// can issue is the strongest possible mark that this is NOT a stablecoin,
// and it also avoids having to custody an issuance key for something that
// only exists so a demo has something to sign against.
//
// -----------------------------------------------------------------------------
// WHAT IT HAS TO SATISFY, AND WHO CHECKS IT
//
// The acceptance criterion isn't invented here: it was already written down
// and is executable.
//
//     PYRUS_X402_PLASMA_TESTNET_ASSET=0x... \
//     PYRUS_X402_PLASMA_TESTNET_NAME="PyrusLLM Test USD" \
//     npm run verificar-x402
//
// It checks three things against the chain: that a contract exists, that
// `authorizationState` doesn't revert (i.e. that it implements EIP-3009),
// and that the DOMAIN_SEPARATOR the contract returns matches the EIP-712
// domain we're going to SIGN with. The third is the one that fails the most
// quietly and the only one that proves the signature is going to verify on
// the other side.
//
// There's a fourth requirement that doesn't come from x402 but from this
// stack: `@x402/evm`'s facilitator reads `name()` and `version()` ON-CHAIN
// before settling (see `eip3009ABI`). Plasma's USD-0 REVERTS on `version()`;
// this one doesn't, because there's no reason to inherit that problem in a
// contract we write ourselves.
//
// -----------------------------------------------------------------------------
// THE TWO transferWithAuthorization OVERLOADS
//
// Not redundancy: `@x402/evm` picks ONE OR THE OTHER by the SIGNATURE'S
// LENGTH (`isECDSA = sigLength === 130`). With 65 bytes it calls the (v, r,
// s) one; with any other length, the `bytes` one. Implementing only one
// leaves half the facilitator's branch calling a function that doesn't
// exist.
//
// WHAT THIS CONTRACT **DOES NOT** DO, and it's worth having it written down
// because the `bytes` overload invites assuming the opposite:
// **it does not support ERC-1271**. `_recuperar` requires 65 bytes and does
// `ecrecover`, so a payer that's a CONTRACT -- a smart wallet, an ERC-4337
// account, a signature wrapped in ERC-6492 -- cannot pay with this asset.
// `@x402/evm` does have that path and will try it; here it reverts.
//
// Not a limitation that's a problem today: D30's payer is a WDK EOA and
// signs 65 bytes. Stated anyway because a comment that promises a
// capability that doesn't exist is the same kind of artifact this project
// chases down everywhere -- the one that looks like proof and isn't.

// -----------------------------------------------------------------------------
// WHY THE `require` MESSAGES ARE IN ENGLISH, AND WHY THEY DON'T GET
// TRANSLATED
//
// This repo's comments are in Spanish and these messages aren't. Not an
// oversight and not something to "fix": **the revert string is a machine
// interface here, not text for a person.**
//
// `@x402/evm` classifies a settlement failure by REGEX-MATCHING the revert
// message (`parseEip3009TransferError`), and those regexes are written
// against Circle's FiatTokenV2, EIP-3009's reference implementation:
//
//     /authorization.*(expired|valid before)/i   -> valid_before_expired
//     /authorization.*not.*valid/i               -> valid_after_in_future
//     /authorization.*used/i                     -> nonce_already_used
//     /transfer.*exceeds.*balance/i               -> insufficient_balance
//     /invalid.*signature/i                       -> invalid_signature
//
// With the messages in Spanish NONE of them match and all five collapse to
// `transaction_failed`. That barely matters today -- D9 charges a fixed cap
// --, and in Phase 10 it breaks something important: the batch settles on
// its own, and those five call for three incompatible actions.
// `nonce_already_used` is an idempotent retry and has to be treated as
// charged; `insufficient_balance` is the other side's problem and doesn't
// get retried; `invalid_signature` isn't accounting, it's reputation. With
// a single `transaction_failed` for all three, the batch can't decide.
//
// The `tUSD:` prefix stays -- it identifies the contract on the explorer
// and doesn't get in any regex's way. There's a test that runs the
// package's REAL regexes against these messages: if someone translates
// them, it breaks.

contract PyrusTestUSD {
    // -------------------------------------------------------------------------
    // What's visible on the explorer. All three say the same thing.
    // -------------------------------------------------------------------------

    string public constant name = "PyrusLLM Test USD";
    string public constant symbol = "tUSD";

    // The EIP-712 domain's `version`. Exposed as a function because
    // @x402/evm's facilitator READS it from the chain before settling.
    string public constant version = "1";

    string public constant AVISO =
        "ACTIVO DE PRUEBA - NO ES UNA STABLECOIN - NO VALE NADA - mint abierto - PyrusLLM D30.3";

    // 6, like USD-0. Not an aesthetic detail: qvac/x402.mjs's
    // `montoEnUnidades` scales micro-dollars by 10^(decimals-6), so with 6 a
    // micro-dollar IS a minimum unit and the test asset is interchangeable
    // with mainnet's for everything the gateway does.
    uint8 public constant decimals = 6;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    // -------------------------------------------------------------------------
    // EIP-3009
    // -------------------------------------------------------------------------

    // The typehashes are computed with keccak256(bytes(...)) in the
    // constructor and not pasted in as hand-written constants: a
    // miscopied constant gives a contract that compiles, deploys, and
    // rejects EVERY signature -- and the cause only shows up against the
    // chain.
    bytes32 public immutable TRANSFER_WITH_AUTHORIZATION_TYPEHASH;
    bytes32 public immutable RECEIVE_WITH_AUTHORIZATION_TYPEHASH;
    bytes32 public immutable CANCEL_AUTHORIZATION_TYPEHASH;

    mapping(address => mapping(bytes32 => bool)) private _authorizationStates;

    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);
    event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce);

    // The domain is tied to the chainId. The deployment one gets stored and
    // RECOMPUTED if it changes, which is what happens in a fork: a signature
    // from the old chain can't be valid on the new one. Same logic EIP-155
    // imposes on transactions, applied to signed authorizations -- and it's
    // exactly why 9745 and 9746 can't be confused with each other (D30.2).
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

    // OPEN MINT. See the header: it's the mark that this isn't a
    // stablecoin, and it avoids custodying an issuance key for a demo. The
    // per-call cap is there so a loop doesn't generate an absurd
    // totalSupply that confuses anyone looking at the explorer, not as a
    // control of any kind.
    uint256 public constant MINT_MAXIMO_POR_LLAMADA = 1000000000000; // 1,000,000 tUSD

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
    // EIP-3009 — signed authorizations, which is what x402 `exact` uses
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

    // `receiveWithAuthorization` is the same but requires whoever sends the
    // transaction to be the recipient. Exists so a third party can't front-run
    // presenting the authorization; x402 doesn't use it today, and it's here
    // because half an EIP-3009 without it isn't EIP-3009.
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

    // Canceling is what gives the payer a way out when they signed something
    // they no longer want settled. Without this, an authorization signed
    // with a far-out `validBefore` can't be withdrawn.
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

    // THE NONCE IS THE PAYMENT'S IDEMPOTENCY KEY (D20). Marking it BEFORE
    // transferring is what makes it so a facilitator retry can't charge
    // twice: the second settlement reverts here, not in our own process.
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

    // ecrecover with the malleability guard. Without it, (v, r, s) and (v',
    // r, -s) recover the same address, i.e. there are TWO valid signatures
    // for the same authorization -- and the nonce only kills one of them.
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
