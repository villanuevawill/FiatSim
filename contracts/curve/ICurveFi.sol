pragma solidity ^0.7.3;
// Solidity Interface
// To get the price of curve tokens this contract interface is used to access the following functions
// get_virtual price, token address, and the balance of underlying tokens

interface ICurveFi {
  function get_virtual_price() external view returns (uint256);
  function token() external view returns (address);
  function balances(uint256 arg0) external view returns (uint256);
  function get_dy(
    int128 i,
    int128 j,
    uint256 dx
  ) external view returns (uint256);
  function get_dy_underlying(
    int128 i,
    int128 j,
    uint256 dx
  ) external view returns (uint256);
  function coins(uint256 arg0) external view returns (address);
  function add_liquidity(
    uint256[2] calldata amounts,
    uint256 deadline
  ) external;
  function exchange(
    int128 i,
    int128 j,
    uint256 dx,
    uint256 min_dy
  ) external;
  function exchange_underlying(
    int128 i,
    int128 j,
    uint256 dx,
    uint256 min_dy,
    address _receiver
  ) external returns (uint256);
  function remove_liquidity(
    uint256 _amount,
    uint256 deadline,
    uint256[2] calldata min_amounts
  ) external;
  function remove_liquidity_imbalance(
    uint256[2] calldata amounts,
    uint256 deadline
  ) external;
}
