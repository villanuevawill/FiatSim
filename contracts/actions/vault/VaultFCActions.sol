// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.4;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {ICodex} from "../../fiat/interfaces/ICodex.sol";
import {IMoneta} from "../../fiat/interfaces/IMoneta.sol";
import {IFIAT} from "../../fiat/interfaces/IFIAT.sol";
import {WAD, toInt256, add, mul, div, wdiv, wmul} from "../../fiat/utils/Math.sol";

import {IVaultFC} from "../../vaults/interfaces/IVaultFC.sol";

import {Vault1155Actions} from "./Vault1155Actions.sol";

interface INotional {
    enum DepositActionType {
        None,
        DepositAsset,
        DepositUnderlying,
        DepositAssetAndMintNToken,
        DepositUnderlyingAndMintNToken,
        RedeemNToken,
        ConvertCashToNToken
    }

    struct MarketParameters {
        bytes32 storageSlot;
        uint256 maturity;
        int256 totalfCash;
        int256 totalAssetCash;
        int256 totalLiquidity;
        uint256 lastImpliedRate;
        uint256 oracleRate;
        uint256 previousTradeTime;
    }

    enum TokenType {
        UnderlyingToken,
        cToken,
        cETH,
        Ether,
        NonMintable
    }

    struct Token {
        address tokenAddress;
        bool hasTransferFee;
        int256 decimals;
        TokenType tokenType;
        uint256 maxCollateralBalance;
    }

    struct BalanceActionWithTrades {
        DepositActionType actionType;
        uint16 currencyId;
        uint256 depositActionAmount;
        uint256 withdrawAmountInternalPrecision;
        bool withdrawEntireCashBalance;
        bool redeemToUnderlying;
        bytes32[] trades;
    }

    struct AssetRateParameters {
        address rateOracle;
        int256 rate;
        int256 underlyingDecimals;
    }

    function getActiveMarkets(uint16 currencyId) external view returns (MarketParameters[] memory);

    function balanceOf(address account, uint256 id) external view returns (uint256);

    function batchBalanceAndTradeAction(address account, BalanceActionWithTrades[] calldata actions) external payable;

    function getSettlementRate(uint16 currencyId, uint40 maturity) external view returns (AssetRateParameters memory);

    function settleAccount(address account) external;

    function withdraw(
        uint16 currencyId,
        uint88 amountInternalPrecision,
        bool redeemToUnderlying
    ) external returns (uint256);

    function getfCashAmountGivenCashAmount(
        uint16 currencyId,
        int88 netCashToAccount,
        uint256 marketIndex,
        uint256 blockTime
    ) external view returns (int256);

    function getCashAmountGivenfCashAmount(
        uint16 currencyId,
        int88 fCashAmount,
        uint256 marketIndex,
        uint256 blockTime
    ) external view returns (int256, int256);

    function getCurrency(uint16 currencyId)
        external
        view
        returns (Token memory assetToken, Token memory underlyingToken);
}

/// @title Constants
/// @notice Copied from https://github.com/notional-finance/contracts-v2/blob/master/contracts/global/Constants.sol
/// Replaced OZ safe math with Math.sol
library Constants {
    int256 internal constant INTERNAL_TOKEN_PRECISION = 1e8;

    uint256 internal constant MAX_TRADED_MARKET_INDEX = 7;

    uint256 internal constant DAY = 86400;
    uint256 internal constant WEEK = DAY * 6;
    uint256 internal constant MONTH = WEEK * 5;
    uint256 internal constant QUARTER = MONTH * 3;
    uint256 internal constant YEAR = QUARTER * 4;

    uint256 internal constant DAYS_IN_WEEK = 6;
    uint256 internal constant DAYS_IN_MONTH = 30;
    uint256 internal constant DAYS_IN_QUARTER = 90;

    uint8 internal constant FCASH_ASSET_TYPE = 1;
    uint8 internal constant MAX_LIQUIDITY_TOKEN_INDEX = 8;

    bytes2 internal constant UNMASK_FLAGS = 0x3FFF;
    uint16 internal constant MAX_CURRENCIES = uint16(UNMASK_FLAGS);
}

/// @title DatetTime
/// @notice Copied from
/// https://github.com/notional-finance/contracts-v2/blob/master/contracts/internal/markets/DateTime.sol
/// Added Custom Errors
library DateTime {
    error DateTime__getReferenceTime_invalidBlockTime();
    error DateTime__getTradedMarket_invalidIndex();
    error DateTime__getMarketIndex_zeroMaxMarketIndex();
    error DateTime__getMarketIndex_invalidMaxMarketIndex();
    error DateTime__getMarketIndex_marketNotFound();

    function getReferenceTime(uint256 blockTime) internal pure returns (uint256) {
        if (blockTime < Constants.QUARTER) revert DateTime__getReferenceTime_invalidBlockTime();
        return blockTime - (blockTime % Constants.QUARTER);
    }

    function getTradedMarket(uint256 index) internal pure returns (uint256) {
        if (index == 1) return Constants.QUARTER;
        if (index == 2) return 2 * Constants.QUARTER;
        if (index == 3) return Constants.YEAR;
        if (index == 4) return 2 * Constants.YEAR;
        if (index == 5) return 5 * Constants.YEAR;
        if (index == 6) return 10 * Constants.YEAR;
        if (index == 7) return 20 * Constants.YEAR;

        revert DateTime__getTradedMarket_invalidIndex();
    }

    function getMarketIndex(
        uint256 maxMarketIndex,
        uint256 maturity,
        uint256 blockTime
    ) internal pure returns (uint256, bool) {
        if (maxMarketIndex == 0) revert DateTime__getMarketIndex_zeroMaxMarketIndex();
        if (maxMarketIndex > Constants.MAX_TRADED_MARKET_INDEX) revert DateTime__getMarketIndex_invalidMaxMarketIndex();

        uint256 tRef = DateTime.getReferenceTime(blockTime);

        for (uint256 i = 1; i <= maxMarketIndex; i++) {
            uint256 marketMaturity = add(tRef, DateTime.getTradedMarket(i));
            // If market matches then is not idiosyncratic
            if (marketMaturity == maturity) return (i, false);
            // Returns the market that is immediately greater than the maturity
            if (marketMaturity > maturity) return (i, true);
        }

        revert DateTime__getMarketIndex_marketNotFound();
    }
}

/// @title EncodeDecode
/// @notice Copied from
/// https://github.com/notional-finance/notional-solidity-sdk/blob/master/contracts/lib/EncodeDecode.sol
/// Added Custom Errors
library EncodeDecode {
    error EncodeDecode__encodeERC1155Id_MAX_CURRENCIES();
    error EncodeDecode__encodeERC1155Id_invalidMaturity();
    error EncodeDecode__encodeERC1155Id_MAX_LIQUIDITY_TOKEN_INDEX();

    enum TradeActionType {
        Lend,
        Borrow,
        AddLiquidity,
        RemoveLiquidity,
        PurchaseNTokenResidual,
        SettleCashDebt
    }

    function decodeERC1155Id(uint256 id)
        internal
        pure
        returns (
            uint16 currencyId,
            uint40 maturity,
            uint8 assetType
        )
    {
        assetType = uint8(id);
        maturity = uint40(id >> 8);
        currencyId = uint16(id >> 48);
    }

    function encodeERC1155Id(
        uint256 currencyId,
        uint256 maturity,
        uint256 assetType
    ) internal pure returns (uint256) {
        if (currencyId > Constants.MAX_CURRENCIES) revert EncodeDecode__encodeERC1155Id_MAX_CURRENCIES();
        if (maturity > type(uint40).max) revert EncodeDecode__encodeERC1155Id_invalidMaturity();
        if (assetType > Constants.MAX_LIQUIDITY_TOKEN_INDEX) {
            revert EncodeDecode__encodeERC1155Id_MAX_LIQUIDITY_TOKEN_INDEX();
        }

        return
            uint256(
                (bytes32(uint256(uint16(currencyId))) << 48) |
                    (bytes32(uint256(uint40(maturity))) << 8) |
                    bytes32(uint256(uint8(assetType)))
            );
    }

    function encodeLendTrade(
        uint8 marketIndex,
        uint88 fCashAmount,
        uint32 minImpliedRate
    ) internal pure returns (bytes32) {
        return
            bytes32(
                (uint256(uint8(TradeActionType.Lend)) << 248) |
                    (uint256(marketIndex) << 240) |
                    (uint256(fCashAmount) << 152) |
                    (uint256(minImpliedRate) << 120)
            );
    }

    function encodeBorrowTrade(
        uint8 marketIndex,
        uint88 fCashAmount,
        uint32 maxImpliedRate
    ) internal pure returns (bytes32) {
        return
            bytes32(
                uint256(
                    (uint256(uint8(TradeActionType.Borrow)) << 248) |
                        (uint256(marketIndex) << 240) |
                        (uint256(fCashAmount) << 152) |
                        (uint256(maxImpliedRate) << 120)
                )
            );
    }
}

// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
// WARNING: These functions meant to be used as a a library for a PRBProxy. Some are unsafe if you call them directly.
// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

/// @title VaultFCActions
/// @notice A set of vault actions for modifying positions collateralized by Notional Finance fCash tokens
contract VaultFCActions is Vault1155Actions {
    using SafeERC20 for IERC20;

    /// ======== Custom Errors ======== ///

    error VaultFCActions__buyCollateralAndModifyDebt_zeroMaxUnderlierAmount();
    error VaultFCActions__sellCollateralAndModifyDebt_zeroFCashAmount();
    error VaultFCActions__sellCollateralAndModifyDebt_matured();
    error VaultFCActions__redeemCollateralAndModifyDebt_zeroFCashAmount();
    error VaultFCActions__redeemCollateralAndModifyDebt_notMatured();
    error VaultFCActions__getMarketIndex_invalidMarket();
    error VaultFCActions__getUnderlierToken_invalidUnderlierTokenType();
    error VaultFCActions__getCToken_invalidAssetTokenType();
    error VaultFCActions__sellfCash_amountOverflow();
    error VaultFCActions__redeemfCash_amountOverflow();
    error VaultFCActions__vaultRedeemAndExit_zeroVaultAddress();
    error VaultFCActions__vaultRedeemAndExit_zeroTokenAddress();
    error VaultFCActions__vaultRedeemAndExit_zeroToAddress();
    error VaultFCActions__onERC1155Received_invalidCaller();
    error VaultFCActions__onERC1155Received_invalidValue();

    /// ======== Storage ======== ///

    /// @notice Address of the Notional V2 monolith
    INotional public immutable notionalV2;
    /// @notice Scale for all fCash tokens (== tokenScale)
    uint256 public immutable fCashScale;

    constructor(
        address codex,
        address moneta,
        address fiat,
        address publican_,
        address notionalV2_
    ) Vault1155Actions(codex, moneta, fiat, publican_) {
        notionalV2 = INotional(notionalV2_);
        fCashScale = uint256(Constants.INTERNAL_TOKEN_PRECISION);
    }

    /// ======== Position Management ======== ///

    /// @notice Buys fCash from underliers before it modifies a Position's collateral
    /// and debt balances and mints/burns FIAT using the underlier token.
    /// The underlier is swapped to fCash token used as collateral.
    /// @dev The user needs to previously approve the UserProxy for spending collateral tokens or FIAT tokens
    /// If `position` is not the UserProxy, the `position` owner needs grant a delegate to UserProxy via Codex
    /// @param vault Address of the Vault
    /// @param token Address of the collateral token (fCash)
    /// @param tokenId fCash Id (ERC1155 tokenId)
    /// @param position Address of the position's owner
    /// @param collateralizer Address of who puts up or receives the collateral delta as underlier tokens
    /// @param creditor Address of who provides or receives the FIAT delta for the debt delta
    /// @param fCashAmount Amount of fCash to buy via underliers and add as collateral [tokenScale]
    /// @param deltaNormalDebt Amount of normalized debt (gross, before rate is applied) to generate (+) or
    /// settle (-) on this Position [wad]
    /// @param minImpliedRate Min. accepted annualized implied lending rate for swapping underliers for fCash [1e9]
    /// @param maxUnderlierAmount Max. amount of underlier to swap for fCash [underlierScale]
    function buyCollateralAndModifyDebt(
        address vault,
        address token,
        uint256 tokenId,
        address position,
        address collateralizer,
        address creditor,
        uint256 fCashAmount,
        int256 deltaNormalDebt,
        uint32 minImpliedRate,
        uint256 maxUnderlierAmount
    ) public {
        if (maxUnderlierAmount == 0) revert VaultFCActions__buyCollateralAndModifyDebt_zeroMaxUnderlierAmount();

        // buy fCash and transfer tokens to be used as collateral into VaultFC
        _buyFCash(tokenId, collateralizer, maxUnderlierAmount, minImpliedRate, uint88(fCashAmount));
        int256 deltaCollateral = toInt256(wdiv(fCashAmount, fCashScale));

        // enter fCash and collateralize position
        modifyCollateralAndDebt(
            vault,
            token,
            tokenId,
            position,
            address(this),
            creditor,
            deltaCollateral,
            deltaNormalDebt
        );
    }

    /// @notice Sells the fCash for underliers after it modifies a Position's collateral and debt balances
    /// and mints/burns FIAT using the underlier token.
    /// @dev The user needs to previously approve the UserProxy for spending collateral tokens or FIAT tokens
    /// If `position` is not the UserProxy, the `position` owner needs grant a delegate to UserProxy via Codex
    /// @param vault Address of the Vault
    /// @param token Address of the collateral token (fCash)
    /// @param tokenId fCash Id (ERC1155 tokenId)
    /// @param position Address of the position's owner
    /// @param collateralizer Address of who puts up or receives the collateral delta as underlier tokens
    /// @param creditor Address of who provides or receives the FIAT delta for the debt delta
    /// @param fCashAmount Amount of fCash to remove as collateral and to swap for underliers [tokenScale]
    /// @param deltaNormalDebt Amount of normalized debt (gross, before rate is applied) to generate (+) or
    /// settle (-) on this Position [wad]
    /// @param maxImpliedRate Max. accepted annualized implied borrow rate for swapping fCash for underliers [1e9]
    function sellCollateralAndModifyDebt(
        address vault,
        address token,
        uint256 tokenId,
        address position,
        address collateralizer,
        address creditor,
        uint256 fCashAmount,
        int256 deltaNormalDebt,
        uint32 maxImpliedRate
    ) public {
        if (fCashAmount == 0) revert VaultFCActions__sellCollateralAndModifyDebt_zeroFCashAmount();
        if (block.timestamp >= getMaturity(tokenId)) revert VaultFCActions__sellCollateralAndModifyDebt_matured();

        int256 deltaCollateral = -toInt256(wdiv(fCashAmount, fCashScale));

        // withdraw fCash from the position
        modifyCollateralAndDebt(
            vault,
            token,
            tokenId,
            position,
            address(this),
            creditor,
            deltaCollateral,
            deltaNormalDebt
        );

        // sell fCash
        _sellfCash(tokenId, collateralizer, uint88(fCashAmount), maxImpliedRate);
    }

    /// @notice Redeems fCash for underliers after it modifies a Position's collateral and debt balances
    /// and mints/burns FIAT using the underlier token.
    /// @dev The user needs to previously approve the UserProxy for spending collateral tokens or FIAT tokens
    /// If `position` is not the UserProxy, the `position` owner needs grant a delegate to UserProxy via Codex
    /// @param vault Address of the Vault
    /// @param token Address of the collateral token (fCash)
    /// @param tokenId fCash Id (ERC1155 tokenId)
    /// @param position Address of the position's owner
    /// @param collateralizer Address of who puts up or receives the collateral delta as underlier tokens
    /// @param creditor Address of who provides or receives the FIAT delta for the debt delta
    /// @param fCashAmount Amount of fCash to remove as collateral and to redeem for underliers [tokenScale]
    /// @param deltaNormalDebt Amount of normalized debt (gross, before rate is applied) to generate (+) or
    /// settle (-) on this Position [wad]
    function redeemCollateralAndModifyDebt(
        address vault,
        address token,
        uint256 tokenId,
        address position,
        address collateralizer,
        address creditor,
        uint256 fCashAmount,
        int256 deltaNormalDebt
    ) public {
        if (fCashAmount == 0) revert VaultFCActions__redeemCollateralAndModifyDebt_zeroFCashAmount();
        if (block.timestamp < getMaturity(tokenId)) revert VaultFCActions__redeemCollateralAndModifyDebt_notMatured();

        int256 deltaCollateral = -toInt256(wdiv(fCashAmount, fCashScale));

        // withdraw fCash from the position and redeem them for underliers
        modifyCollateralAndDebt(
            vault,
            token,
            tokenId,
            position,
            collateralizer,
            creditor,
            deltaCollateral,
            deltaNormalDebt
        );
    }

    /// @notice Buys fCash tokens (shares) from the Notional AMM
    /// @dev The amount of underlier set as argument is the upper limit to be paid
    /// @param tokenId fCash Id (ERC1155 tokenId)
    /// @param from Address who pays for the fCash
    /// @param maxUnderlierAmount Max. amount of underlier to swap for fCash [underlierScale]
    /// @param minImpliedRate Min. accepted annualized implied lending rate for lending out underliers for fCash [1e9]
    /// @param fCashAmount Amount of fCash to buy via underliers [tokenScale]
    function _buyFCash(
        uint256 tokenId,
        address from,
        uint256 maxUnderlierAmount,
        uint32 minImpliedRate,
        uint88 fCashAmount
    ) internal {
        (IERC20 underlier, ) = getUnderlierToken(tokenId);

        uint256 balanceBefore = 0;
        // if `from` is set to an external address then transfer amount to the proxy first
        // requires `from` to have set an allowance for the proxy
        if (from != address(0) && from != address(this)) {
            balanceBefore = underlier.balanceOf(address(this));
            underlier.safeTransferFrom(from, address(this), maxUnderlierAmount);
        }

        INotional.BalanceActionWithTrades[] memory action = new INotional.BalanceActionWithTrades[](1);
        action[0].actionType = INotional.DepositActionType.DepositUnderlying;
        action[0].depositActionAmount = maxUnderlierAmount;
        action[0].currencyId = getCurrencyId(tokenId);
        action[0].withdrawEntireCashBalance = true;
        action[0].redeemToUnderlying = true;
        action[0].trades = new bytes32[](1);
        action[0].trades[0] = EncodeDecode.encodeLendTrade(getMarketIndex(tokenId), fCashAmount, minImpliedRate);

        if (underlier.allowance(address(this), address(notionalV2)) < maxUnderlierAmount) {
            // approve notionalV2 to transfer underlier tokens on behalf of proxy
            underlier.approve(address(notionalV2), maxUnderlierAmount);
        }

        notionalV2.batchBalanceAndTradeAction(address(this), action);

        // Send any residuals underlier back to the sender
        if (from != address(0) && from != address(this)) {
            uint256 balanceAfter = underlier.balanceOf(address(this));
            uint256 residual = balanceAfter - balanceBefore;
            if (residual > 0) underlier.safeTransfer(from, residual);
        }
    }

    /// @dev Sells an fCash tokens (shares) back on the Notional AMM
    /// @param tokenId fCash Id (ERC1155 tokenId)
    /// @param fCashAmount The amount of fCash to sell [tokenScale]
    /// @param to Receiver of the underlier tokens
    /// @param maxImpliedRate Max. accepted annualized implied borrow rate for swapping fCash for underliers [1e9]
    function _sellfCash(
        uint256 tokenId,
        address to,
        uint88 fCashAmount,
        uint32 maxImpliedRate
    ) internal {
        if (fCashAmount > type(uint88).max) revert VaultFCActions__sellfCash_amountOverflow();

        (IERC20 underlier, ) = getUnderlierToken(tokenId);

        INotional.BalanceActionWithTrades[] memory action = new INotional.BalanceActionWithTrades[](1);
        action[0].actionType = INotional.DepositActionType.None;
        action[0].currencyId = getCurrencyId(tokenId);
        action[0].withdrawEntireCashBalance = true;
        action[0].redeemToUnderlying = true;
        action[0].trades = new bytes32[](1);
        action[0].trades[0] = EncodeDecode.encodeBorrowTrade(getMarketIndex(tokenId), fCashAmount, maxImpliedRate);

        uint256 balanceBefore = underlier.balanceOf(address(this));
        notionalV2.batchBalanceAndTradeAction(address(this), action);
        uint256 balanceAfter = underlier.balanceOf(address(this));

        // Send the resulting underlier to the user
        underlier.safeTransfer(to, balanceAfter - balanceBefore);
    }

    /// @notice Redeems fCash for underliers (if fCash has matured) and transfers them from the `vault` to `to`
    /// @param vault Address of the Vault to exit
    /// @param token Address of the collateral token (fCash)
    /// @param tokenId fCash Id (ERC1155 token id)
    /// @param to Address which receives the fCash / redeemed underlier tokens
    /// @param amount Amount of collateral tokens to exit or redeem and exit [tokenScale]
    function exitVault(
        address vault,
        address token,
        uint256 tokenId,
        address to,
        uint256 amount
    ) public override {
        if (block.timestamp < getMaturity(tokenId)) {
            super.exitVault(vault, token, tokenId, to, amount);
        } else {
            if (vault == address(0)) revert VaultFCActions__vaultRedeemAndExit_zeroVaultAddress();
            if (token == address(0)) revert VaultFCActions__vaultRedeemAndExit_zeroTokenAddress();
            if (to == address(0)) revert VaultFCActions__vaultRedeemAndExit_zeroToAddress();
            IVaultFC(vault).redeemAndExit(tokenId, to, amount);
        }
    }

    /// ======== View Methods ======== ///

    /// @notice Returns an amount of fCash tokens for a given amount of the fCashs underlier token (e.g. USDC)
    /// @param tokenId fCash Id (ERC1155 tokenId)
    /// @param amount Amount of underlier token [underlierScale]
    /// @return Amount of fCash [tokenScale]
    function underlierToFCash(uint256 tokenId, uint256 amount) public view returns (uint256) {
        (, uint256 underlierScale) = getUnderlierToken(tokenId);
        return
            uint256(
                _adjustForRounding(
                    notionalV2.getfCashAmountGivenCashAmount(
                        getCurrencyId(tokenId),
                        -int88(toInt256(div(mul(amount, fCashScale), underlierScale))),
                        getMarketIndex(tokenId),
                        block.timestamp
                    )
                )
            );
    }

    /// @notice Returns a amount of the fCashs underlier token for a given amount of fCash tokens (e.g. fUSDC)
    /// @param tokenId fCash Id (ERC1155 tokenId)
    /// @param amount Amount of fCash [tokenScale]
    /// @return Amount of underlier [underlierScale]
    function fCashToUnderlier(uint256 tokenId, uint256 amount) external view returns (uint256) {
        (, uint256 underlierScale) = getUnderlierToken(tokenId);
        (, int256 netUnderlyingCash) = notionalV2.getCashAmountGivenfCashAmount(
            getCurrencyId(tokenId),
            -int88(toInt256(amount)),
            getMarketIndex(tokenId),
            block.timestamp
        );
        return div(mul(underlierScale, uint256(_adjustForRounding(netUnderlyingCash))), uint256(fCashScale));
    }

    /// @notice Returns the underlying fCash currency
    /// @param tokenId fCash Id (ERC1155 tokenId)
    /// @return currencyId (Notional Finance)
    function getCurrencyId(uint256 tokenId) public pure returns (uint16 currencyId) {
        (currencyId, , ) = EncodeDecode.decodeERC1155Id(tokenId);
    }

    /// @notice Returns the current market index for this fCash asset. If this returns
    /// zero that means it is idiosyncratic and cannot be traded.
    /// @param tokenId fCash Id (ERC1155 tokenId)
    /// @return Index of the Notional Finance market
    function getMarketIndex(uint256 tokenId) public view returns (uint8) {
        (uint256 marketIndex, bool isInvalidMarket) = DateTime.getMarketIndex(
            Constants.MAX_TRADED_MARKET_INDEX,
            getMaturity(tokenId),
            block.timestamp
        );
        if (isInvalidMarket) revert VaultFCActions__getMarketIndex_invalidMarket();

        // Market index as defined does not overflow this conversion
        return uint8(marketIndex);
    }

    /// @notice Returns the underlying fCash maturity of the token
    function getMaturity(uint256 tokenId) public pure returns (uint40 maturity) {
        (, maturity, ) = EncodeDecode.decodeERC1155Id(tokenId);
    }

    /// @notice Returns the underlier of the token of the token that this token settles to, and its precision scale.
    /// E.g. for fUSDC it returns the USDC address and the scale of USDC
    /// @param tokenId fCash ID (ERC1155 tokenId)
    /// @return underlierToken Address of the underlier (for fUSDC it would be USDC)
    /// @return underlierScale Precision of the underlier (USDC it would be 1e6)
    function getUnderlierToken(uint256 tokenId) public view returns (IERC20 underlierToken, uint256 underlierScale) {
        (, INotional.Token memory underlier) = notionalV2.getCurrency(getCurrencyId(tokenId));
        if (underlier.tokenType != INotional.TokenType.UnderlyingToken) {
            revert VaultFCActions__getUnderlierToken_invalidUnderlierTokenType();
        }
        // decimals is 1eDecimals
        return (IERC20(underlier.tokenAddress), uint256(underlier.decimals));
    }

    /// @notice Returns the cToken (from Compound) which the fCash settles to at maturity
    /// @param tokenId fCash ID (ERC1155 tokenId)
    /// @return cToken Address of the cToken
    /// @return cTokenScale Precision scale of the cToken (1e8)
    function getCToken(uint256 tokenId) public view returns (IERC20 cToken, uint256 cTokenScale) {
        (INotional.Token memory asset, ) = notionalV2.getCurrency(getCurrencyId(tokenId));
        if (asset.tokenType != INotional.TokenType.cToken) {
            revert VaultFCActions__getCToken_invalidAssetTokenType();
        }
        // decimals is 1eDecimals
        return (IERC20(asset.tokenAddress), uint256(asset.decimals));
    }

    /// @dev Adjusts the returned cash values for potential rounding issues in calculations
    function _adjustForRounding(int256 x) private pure returns (int256) {
        int256 y = (x < 1e7) ? int256(1) : (x / 1e7);
        return x - y;
    }

    /// ======== ERC1155 ======== ///

    /// @notice Grants or revokes permission to `spender` to transfer the UserProxy's ERC1155 tokens,
    /// according to `approved`
    /// @param token Address of the ERC1155 token
    /// @param spender Address of the spender
    /// @param approved Boolean indicating `spender` approval
    function setApprovalForAll(
        address token,
        address spender,
        bool approved
    ) external {
        IERC1155(token).setApprovalForAll(spender, approved);
    }
}
