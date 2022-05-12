// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.4;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {ICodex} from "../../fiat/interfaces/ICodex.sol";
import {IFIAT} from "../../fiat/interfaces/IFIAT.sol";
import {IMoneta} from "../../fiat/interfaces/IMoneta.sol";
import {INoLossCollateralAuction} from "../../fiat/interfaces/INoLossCollateralAuction.sol";
import {IVault} from "../../fiat/interfaces/IVault.sol";
import {WAD, toInt256, sub, mul, div, wmul, wdiv} from "../../fiat/utils/Math.sol";

// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
// WARNING: These functions meant to be used as a a library for a PRBProxy. Some are unsafe if you call them directly.
// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

/// @title NoLossCollateralAuction actions
/// @notice A set of actions for buying collateral from NoLossCollateralAuction
contract NoLossCollateralAuctionActions {
    using SafeERC20 for IERC20;

    /// ======== Custom Errors ======== ///

    error NoLossCollateralAuctionActions__collateralAuctionCall_msgSenderNotNoLossCollateralAuction();
    error NoLossCollateralAuctionActions__collateralAuctionCall_senderNotProxy();

    /// ======== Storage ======== ///

    /// @notice Codex
    ICodex public immutable codex;
    /// @notice Moneta
    IMoneta public immutable moneta;
    /// @notice FIAT token
    IFIAT public immutable fiat;
    /// @notice Collateral Auction
    INoLossCollateralAuction public immutable noLossCollateralAuction;

    constructor(
        address codex_,
        address moneta_,
        address fiat_,
        address noLossCollateralAuction_
    ) {
        codex = ICodex(codex_);
        moneta = IMoneta(moneta_);
        fiat = IFIAT(fiat_);
        noLossCollateralAuction = INoLossCollateralAuction(noLossCollateralAuction_);
    }

    /// @notice Sets `amount` as the allowance of `spender` over the UserProxy's FIAT
    /// @param spender Address of the spender
    /// @param amount Amount of tokens to approve [wad]
    function approveFIAT(address spender, uint256 amount) external {
        fiat.approve(spender, amount);
    }

    /// @notice Buys up to `collateralAmount` of collateral from auction `auctionid` using
    /// FIAT from `from` and sending the bought collateral to `recipient`
    /// @dev The user needs to previously approve the UserProxy for spending collateral tokens or FIAT tokens
    /// @param vault Address of the collateral's vault
    /// @param tokenId ERC1155 or ERC721 style TokenId (leave at 0 for ERC20)
    /// @param from Address which puts up the FIAT
    /// @param auctionId Id of the auction to buy collateral from
    /// @param maxCollateralToBuy Max. amount of collateral to buy [wad]
    /// @param maxPrice Max. acceptable price to pay for collateral (Credit / collateral) [wad]
    /// @param recipient Address which receives the bought collateral
    function takeCollateral(
        address vault,
        uint256 tokenId,
        address from,
        uint256 auctionId,
        uint256 maxCollateralToBuy,
        uint256 maxPrice,
        address recipient
    ) external {
        // calculate max. amount credit to pay
        uint256 maxCredit = wmul(maxCollateralToBuy, maxPrice);

        // if `bidder` is set to an external address then transfer amount to the proxy first
        // requires `from` to have set an allowance for the proxy
        if (from != address(0) && from != address(this)) fiat.transferFrom(from, address(this), maxCredit);

        // enter credit into Moneta, requires approving Moneta to transfer FIAT on the UserProxy's behalf
        moneta.enter(address(this), maxCredit);

        // proxy needs to delegate ability to transfer internal credit on its behalf to NoLossCollateralAuction first
        if (codex.delegates(address(this), address(noLossCollateralAuction)) != 1)
            codex.grantDelegate(address(noLossCollateralAuction));

        uint256 credit = codex.credit(address(this));
        uint256 balance = codex.balances(vault, tokenId, address(this));
        noLossCollateralAuction.takeCollateral(auctionId, maxCollateralToBuy, maxPrice, address(this), new bytes(0));

        // proxy needs to delegate ability to transfer internal credit on its behalf to Moneta first
        if (codex.delegates(address(this), address(moneta)) != 1) codex.grantDelegate(address(moneta));

        // refund unused credit to `from`
        moneta.exit(from, sub(maxCredit, sub(credit, codex.credit(address(this)))));

        // transfer bought collateral to recipient
        uint256 bought = wmul(sub(codex.balances(vault, tokenId, address(this)), balance), IVault(vault).tokenScale());
        IVault(vault).exit(tokenId, recipient, bought);
    }
}
